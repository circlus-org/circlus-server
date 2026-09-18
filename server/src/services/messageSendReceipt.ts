import type { PoolClient } from 'pg';
export class MessageAlreadyAccepted extends Error {
  constructor(public readonly messageId: string, public readonly createdAt: number) {
    super('Message already accepted');
  }
}
export async function rememberMessageSend(client: PoolClient, familyId: string, scope: string, deviceId: string, clientId: string, messageId: string, createdAt: number): Promise<void> {
  // Keep the receipt even when message content is physically cleared/expired.
  const result = await client.query(`INSERT INTO message_send_receipts (family_id,scope,device_id,client_message_id,message_id,created_at)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING message_id`,[familyId,scope,deviceId,clientId,messageId,createdAt]);
  if (!result.rows.length) {
    const existing = await client.query('SELECT message_id,created_at FROM message_send_receipts WHERE family_id=$1 AND scope=$2 AND device_id=$3 AND client_message_id=$4', [familyId,scope,deviceId,clientId]);
    throw new MessageAlreadyAccepted(existing.rows[0].message_id, Number(existing.rows[0].created_at));
  }
}
