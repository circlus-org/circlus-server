import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getStorageRuntimeConfig } from '../config/serverRuntimeConfig';

function configuredMaxConcurrentUploads(): number {
  return getStorageRuntimeConfig().attachments.maxConcurrentUploads;
}

const activeUploadKeys = new Set<string>();
let activeUploadCount = 0;

export type UploadSlotResult =
  | { acquired: true; release: () => void }
  | { acquired: false; reason: 'duplicate' | 'capacity' };

export function tryAcquireUploadSlot(uploadKey: string): UploadSlotResult {
  if (activeUploadKeys.has(uploadKey)) {
    return { acquired: false, reason: 'duplicate' };
  }
  if (activeUploadCount >= configuredMaxConcurrentUploads()) {
    return { acquired: false, reason: 'capacity' };
  }

  activeUploadKeys.add(uploadKey);
  activeUploadCount += 1;
  let released = false;
  return {
    acquired: true,
    release: () => {
      if (released) return;
      released = true;
      activeUploadKeys.delete(uploadKey);
      activeUploadCount = Math.max(0, activeUploadCount - 1);
    }
  };
}

export class UploadStreamError extends Error {
  constructor(
    public readonly code: 'PAYLOAD_TOO_LARGE' | 'UPLOAD_SIZE_MISMATCH',
    message: string
  ) {
    super(message);
    this.name = 'UploadStreamError';
  }
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
}

export async function streamUploadToFile(params: {
  source: Readable;
  tempPath: string;
  finalPath: string;
  maxBytes: number;
  expectedBytes?: number;
}): Promise<{ bytesWritten: number; sha256: string }> {
  await fs.promises.mkdir(path.dirname(params.tempPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(params.finalPath), { recursive: true });
  await unlinkIfPresent(params.tempPath);

  let bytesWritten = 0;
  const hash = createHash('sha256');
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesWritten += chunk.length;
      if (bytesWritten > params.maxBytes) {
        callback(new UploadStreamError(
          'PAYLOAD_TOO_LARGE',
          `Upload exceeds the ${params.maxBytes} byte HTTP body limit`
        ));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });

  try {
    await pipeline(
      params.source,
      meter,
      fs.createWriteStream(params.tempPath, { flags: 'wx' })
    );
    if (params.expectedBytes !== undefined && bytesWritten !== params.expectedBytes) {
      throw new UploadStreamError(
        'UPLOAD_SIZE_MISMATCH',
        `Upload contains ${bytesWritten} bytes; expected ${params.expectedBytes}`
      );
    }
    await fs.promises.rename(params.tempPath, params.finalPath);
    return { bytesWritten, sha256: hash.digest('hex') };
  } catch (error) {
    await unlinkIfPresent(params.tempPath);
    throw error;
  }
}
