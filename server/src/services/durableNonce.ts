import { createHash } from 'node:crypto';
import { query } from '../db';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let nextCleanup = 0;
/** Called only after signature verification. DB failure fails authentication closed. */
export async function claimDurableNonce(signerId: string, nonce: string, expiresAt: number): Promise<boolean> {
  const result = await query(
    `INSERT INTO signed_request_nonces (signer_hash, nonce_hash, expires_at)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING signer_hash`,
    [hash(signerId), hash(nonce), new Date(expiresAt)]
  );
  if (Date.now() >= nextCleanup) {
    nextCleanup = Date.now() + 60_000;
    // Bounded cleanup; never delete a still-valid future-dated envelope.
    await query(`DELETE FROM signed_request_nonces WHERE ctid IN (
      SELECT ctid FROM signed_request_nonces WHERE expires_at < NOW() LIMIT 10000
    )`);
    // Drop old response bodies, retaining tombstones so an old action never executes again.
    await query(`UPDATE signed_operation_results SET response=NULL WHERE ctid IN (
      SELECT ctid FROM signed_operation_results
      WHERE response IS NOT NULL AND created_at < NOW() - INTERVAL '30 days' LIMIT 1000
    )`);
  }
  return result.rows.length === 1;
}
