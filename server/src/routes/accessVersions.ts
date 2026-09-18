import { Router } from 'express';
import { verifySignature, requireActiveIdentity, type AuthRequest } from '../middleware/auth';
import { query } from '../db';
import { accessResource, accessScope } from '../../../shared/accessOperations';
const router = Router();
// Only opaque revisions, no state/keys/permissions are disclosed here. Actual mutations
// retain all of their existing authorization checks and run inside a transaction.
router.post('/version', verifySignature, requireActiveIdentity, async (req: AuthRequest, res, next) => {
  const payload = req.signedRequest?.payload as {type?: string; path?: string; payload?: unknown};
  let key: string;
  try {
    key = accessResource(payload?.type || '', payload?.path || '', payload?.payload, req.device!.identityId);
  } catch {
    return res.status(400).json({status:'error',error:{code:'INVALID_REQUEST',message:'Invalid access operation target'}});
  }
  try {
    const result = await query('SELECT version_id FROM signed_resource_versions WHERE family_id=$1 AND resource_key=$2',
      [accessScope(payload.type!, req.familyId!), key]);
    return res.json({status:'ok',result:{version:result.rows[0]?.version_id || '0'}});
  } catch (error) { next(error); }
});
export default router;
