import type { CircleId, VpsId } from './types';

export type CircleKey = string & { readonly __circleKey: unique symbol };

const PREFIX = 'ck1.';

function encodePart(value: string): string {
  const bytes = new TextEncoder().encode(value.trim());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodePart(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

/** Stable client-side namespace key. It is never used as a server routing selector. */
export function createCircleKey(vpsId: VpsId | string, circleId: CircleId | string): CircleKey {
  const normalizedVpsId = String(vpsId || '').trim();
  const normalizedCircleId = String(circleId || '').trim();
  if (!normalizedVpsId || !normalizedCircleId) throw new Error('CircleKey requires vpsId and circleId');
  return `${PREFIX}${encodePart(normalizedVpsId)}.${encodePart(normalizedCircleId)}` as CircleKey;
}

export function parseCircleKey(value: string): { vpsId: VpsId; circleId: CircleId } | null {
  const normalized = String(value || '').trim();
  if (!normalized.startsWith(PREFIX)) return null;
  const parts = normalized.slice(PREFIX.length).split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const vpsId = decodePart(parts[0]).trim();
    const circleId = decodePart(parts[1]).trim();
    return vpsId && circleId ? { vpsId, circleId } : null;
  } catch {
    return null;
  }
}

