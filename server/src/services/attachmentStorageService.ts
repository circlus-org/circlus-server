import fs from 'fs';
import path from 'path';
import type { Readable } from 'node:stream';
import { streamUploadToFile } from './uploadStreamService';
import { getStorageRuntimeConfig } from '../config/serverRuntimeConfig';

export class AttachmentStorageService {
  private get rootDir(): string {
    return getStorageRuntimeConfig().attachments.rootDir;
  }

  private get tmpDir(): string {
    return getStorageRuntimeConfig().attachments.tmpDir;
  }

  async ensureDirectories(): Promise<void> {
    await fs.promises.mkdir(this.rootDir, { recursive: true });
    await fs.promises.mkdir(this.tmpDir, { recursive: true });
  }

  buildStorageKey(familyId: string, blobId: string): string {
    return path.posix.join(familyId, `${blobId}.bin`);
  }

  resolveFinalPath(storageKey: string): string {
    return path.join(this.rootDir, storageKey);
  }

  resolveTempPath(reservationId: string): string {
    return path.join(this.tmpDir, `${reservationId}.upload`);
  }

  async writeUploadBuffer(params: {
    reservationId: string;
    storageKey: string;
    body: Buffer;
  }): Promise<number> {
    await this.ensureDirectories();

    const tempPath = this.resolveTempPath(params.reservationId);
    const finalPath = this.resolveFinalPath(params.storageKey);
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });

    await fs.promises.writeFile(tempPath, params.body);
    await fs.promises.rename(tempPath, finalPath);
    return params.body.length;
  }

  async writeUploadStream(params: {
    reservationId: string;
    storageKey: string;
    source: Readable;
    maxBytes: number;
    expectedBytes: number;
  }): Promise<{ bytesWritten: number; sha256: string }> {
    return streamUploadToFile({
      source: params.source,
      tempPath: this.resolveTempPath(params.reservationId),
      finalPath: this.resolveFinalPath(params.storageKey),
      maxBytes: params.maxBytes,
      expectedBytes: params.expectedBytes
    });
  }

  async readBlob(storageKey: string): Promise<fs.ReadStream> {
    return fs.createReadStream(this.resolveFinalPath(storageKey));
  }

  async deleteBlob(storageKey: string): Promise<boolean> {
    const finalPath = this.resolveFinalPath(storageKey);
    try {
      await fs.promises.unlink(finalPath);
      return true;
    } catch (error: any) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  async deleteTempUpload(reservationId: string): Promise<void> {
    const tempPath = this.resolveTempPath(reservationId);
    try {
      await fs.promises.unlink(tempPath);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  async getFreeBytes(): Promise<number> {
    await this.ensureDirectories();
    const stats = await fs.promises.statfs(this.rootDir);
    return Number(stats.bavail) * Number(stats.bsize);
  }
}

export const attachmentStorageService = new AttachmentStorageService();
