import { createSignatureMessage } from '../../../shared/signatureMessage';
export class MessageRevisionConflict extends Error {
  status = 409;
  code = 'CONFLICT';
  constructor() { super('Message revision changed; reload before editing'); }
}

export function sameMessageClaim(a: unknown, b: unknown): boolean {
  return !!a && !!b && createSignatureMessage({payload:a} as any) === createSignatureMessage({payload:b} as any);
}
