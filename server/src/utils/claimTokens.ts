import crypto from 'crypto';
import { nanoid } from 'nanoid';

export function createOpaqueClaimToken(prefix: string): string {
  return `${prefix}_${nanoid(32)}`;
}

export function hashClaimToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}
