import { randomUUID, createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type { RequestHandler } from 'express';
import { inTransactionContext, transaction } from '../db';
import { createSignatureMessage } from '../../../shared/signatureMessage';

export class OperationConflict extends Error {}
export class AccessVersionConflict extends OperationConflict {}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
type Reply = { status: number; body: unknown };
function seal(reply: Reply, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(hash(secret), 'hex'), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(reply)), cipher.final()]);
  return {iv:iv.toString('base64'),data:data.toString('base64'),tag:cipher.getAuthTag().toString('base64')};
}
function open(value: ReturnType<typeof seal>, secret: string): Reply {
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(hash(secret), 'hex'), Buffer.from(value.iv,'base64'));
  decipher.setAuthTag(Buffer.from(value.tag,'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data,'base64')),decipher.final()]).toString());
}
/** Database changes and encrypted response commit together. Identity/auth middleware runs first. */
export function reliableOperation(handler: RequestHandler, resource?: (req: any) => string, options?: { expectedVersion: true; scope: (req: any) => string }): RequestHandler {
  return async (req: any, res, next) => {
    const signed = req.signedRequest || req.body;
    const id = signed?.operationId;
    if (typeof id !== 'string' || !/^[0-9a-f]{16}-[0-9a-f]{64}$/.test(id)
        || parseInt(id.slice(0,16),16) > Date.now() + 60_000) {
      res.status(400).json({status:'error',error:{code:'INVALID_REQUEST',message:'A stable signed operationId is required; update the client'}}); return;
    }
    const familyId = options ? options.scope(req) : String(req.familyId || '');
    const signerId = String(signed.signerId);
    const type = String(signed.type);
    const key = [familyId,signerId,type,hash(id)];
    const secret = JSON.stringify([familyId,signerId,type,id]);
    const fingerprint = hash(createSignatureMessage({payload:signed.payload, params:req.params, ...(options ? {expectedVersion:signed.expectedVersion,accessPath:signed.accessPath} : {})} as any));
    try {
      const reply = await transaction(client => inTransactionContext(client, async () => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[JSON.stringify(key)]);
        const previous = await client.query("SELECT fingerprint,response,created_at < NOW() - INTERVAL '30 days' AS expired FROM signed_operation_results WHERE family_id=$1 AND signer_id=$2 AND operation_type=$3 AND operation_hash=$4",key);
        if (previous.rows[0]) {
          if (previous.rows[0].fingerprint !== fingerprint) throw new OperationConflict('operationId was used with different content');
          if (previous.rows[0].expired || !previous.rows[0].response) throw new OperationConflict('Operation result expired; inspect current state');
          return open(previous.rows[0].response,secret);
        }
        if (resource) {
          const resourceKey = resource(req);
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[JSON.stringify([familyId,resourceKey])]);
          if (options) {
            if (typeof signed.expectedVersion !== 'string' || !/^(0|[0-9a-f-]{36})$/.test(signed.expectedVersion)) {
              throw Object.assign(new Error('Missing access version'), {reply:{status:400,body:{status:'error',error:{code:'INVALID_REQUEST',message:'A signed expectedVersion is required; update the client'}}}});
            }
            const current = await client.query('SELECT version_id FROM signed_resource_versions WHERE family_id=$1 AND resource_key=$2',[familyId,resourceKey]);
            if ((current.rows[0]?.version_id || '0') !== signed.expectedVersion) {
              throw new AccessVersionConflict('Access changed. Refresh the current state and explicitly confirm the action again.');
            }
            await client.query(`INSERT INTO signed_resource_versions (family_id,resource_key,version_id) VALUES ($1,$2,$3)
              ON CONFLICT (family_id,resource_key) DO UPDATE SET version_id=EXCLUDED.version_id`,[familyId,resourceKey,randomUUID()]);
          } else {
          const version = await client.query(`INSERT INTO signed_resource_versions (family_id,resource_key,version_id) VALUES ($1,$2,$3)
            ON CONFLICT (family_id,resource_key) DO UPDATE SET version_id=EXCLUDED.version_id
            WHERE signed_resource_versions.version_id < EXCLUDED.version_id RETURNING version_id`,[familyId,resourceKey,id]);
          if (!version.rows.length) throw new OperationConflict('A newer change already exists');
          }
        }
        let captured: Reply | undefined;
        const response = Object.create(res);
        let status = 200;
        response.status = (code: number) => {status=code;return response;};
        response.json = (body: unknown) => {captured={status,body};return response;};
        await handler(req,response,next);
        if (!captured) throw new Error('Reliable operation did not produce a JSON response');
        if (captured.status >= 400) throw Object.assign(new Error('Operation failed'),{reply:captured});
        await client.query(`INSERT INTO signed_operation_results (family_id,signer_id,operation_type,operation_hash,fingerprint,response)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,[...key,fingerprint,JSON.stringify(seal(captured,secret))]);
        return captured;
      }));
      res.status(reply.status).json(reply.body);
    } catch (error: any) {
      if (error.reply) { res.status(error.reply.status).json(error.reply.body); return; }
      if (error instanceof AccessVersionConflict) { res.status(409).json({status:'error',error:{code:'ACCESS_VERSION_CONFLICT',message:error.message}});return; }
      if (error instanceof OperationConflict) { res.status(409).json({status:'error',error:{code:'CONFLICT',message:error.message}});return; }
      next(error);
    }
  };
}
