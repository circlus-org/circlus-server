import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  streamUploadToFile,
  tryAcquireUploadSlot,
  UploadStreamError
} from './uploadStreamService';

describe('uploadStreamService', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'circlus-upload-stream-'));
    process.env.ATTACHMENTS_MAX_CONCURRENT_UPLOADS = '2';
  });

  afterEach(async () => {
    delete process.env.ATTACHMENTS_MAX_CONCURRENT_UPLOADS;
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  });

  it('streams to a temporary file, verifies size and atomically publishes it', async () => {
    const body = Buffer.from('encrypted attachment');
    const tempPath = path.join(rootDir, 'tmp', 'upload.part');
    const finalPath = path.join(rootDir, 'blobs', 'upload.bin');

    const result = await streamUploadToFile({
      source: Readable.from(body),
      tempPath,
      finalPath,
      maxBytes: 1024,
      expectedBytes: body.length
    });

    expect(result).toEqual({
      bytesWritten: body.length,
      sha256: createHash('sha256').update(body).digest('hex')
    });
    expect(await fs.promises.readFile(finalPath)).toEqual(body);
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  it('removes the temporary file when the hard limit is exceeded', async () => {
    const tempPath = path.join(rootDir, 'tmp', 'oversized.part');
    const finalPath = path.join(rootDir, 'blobs', 'oversized.bin');

    await expect(streamUploadToFile({
      source: Readable.from(Buffer.alloc(32)),
      tempPath,
      finalPath,
      maxBytes: 16
    })).rejects.toMatchObject<UploadStreamError>({ code: 'PAYLOAD_TOO_LARGE' });

    expect(fs.existsSync(tempPath)).toBe(false);
    expect(fs.existsSync(finalPath)).toBe(false);
  });

  it('rejects a completed stream whose size differs from the reservation', async () => {
    const tempPath = path.join(rootDir, 'tmp', 'mismatch.part');
    const finalPath = path.join(rootDir, 'blobs', 'mismatch.bin');

    await expect(streamUploadToFile({
      source: Readable.from(Buffer.alloc(8)),
      tempPath,
      finalPath,
      maxBytes: 16,
      expectedBytes: 9
    })).rejects.toMatchObject<UploadStreamError>({ code: 'UPLOAD_SIZE_MISMATCH' });

    expect(fs.existsSync(tempPath)).toBe(false);
    expect(fs.existsSync(finalPath)).toBe(false);
  });

  it('limits total uploads and rejects duplicate reservation streams', () => {
    const first = tryAcquireUploadSlot('first');
    const second = tryAcquireUploadSlot('second');
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(true);
    expect(tryAcquireUploadSlot('first')).toEqual({ acquired: false, reason: 'duplicate' });
    expect(tryAcquireUploadSlot('third')).toEqual({ acquired: false, reason: 'capacity' });

    if (first.acquired) first.release();
    const third = tryAcquireUploadSlot('third');
    expect(third.acquired).toBe(true);

    if (second.acquired) second.release();
    if (third.acquired) third.release();
  });
});

