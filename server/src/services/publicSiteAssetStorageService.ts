import fs from 'fs';
import path from 'path';
import type { Readable } from 'node:stream';
import { streamUploadToFile } from './uploadStreamService';
import { getStorageRuntimeConfig } from '../config/serverRuntimeConfig';

export class PublicSiteAssetStorageService {
  private get rootDir(): string {
    return getStorageRuntimeConfig().publicSite.assetsDir;
  }

  private get tmpDir(): string {
    return getStorageRuntimeConfig().publicSite.assetsTmpDir;
  }

  buildStorageKey(familyId: string, assetId: string): string {
    return path.posix.join(familyId, `${assetId}.bin`);
  }

  resolveFinalPath(storageKey: string): string {
    return path.join(this.rootDir, storageKey);
  }

  async writeUploadBuffer(params: {
    assetId: string;
    storageKey: string;
    body: Buffer;
  }): Promise<number> {
    await fs.promises.mkdir(this.rootDir, { recursive: true });
    await fs.promises.mkdir(this.tmpDir, { recursive: true });
    const tempPath = path.join(this.tmpDir, `${params.assetId}.upload`);
    const finalPath = this.resolveFinalPath(params.storageKey);
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.promises.writeFile(tempPath, params.body);
    await fs.promises.rename(tempPath, finalPath);
    return params.body.length;
  }

  async writeUploadStream(params: {
    assetId: string;
    storageKey: string;
    source: Readable;
    maxBytes: number;
    expectedBytes: number;
  }): Promise<{ bytesWritten: number; sha256: string }> {
    return streamUploadToFile({
      source: params.source,
      tempPath: path.join(this.tmpDir, `${params.assetId}.upload`),
      finalPath: this.resolveFinalPath(params.storageKey),
      maxBytes: params.maxBytes,
      expectedBytes: params.expectedBytes
    });
  }

  readAsset(storageKey: string, options?: { start?: number; end?: number }): fs.ReadStream {
    return fs.createReadStream(this.resolveFinalPath(storageKey), options);
  }

  async deleteAsset(storageKey: string): Promise<boolean> {
    try {
      await fs.promises.unlink(this.resolveFinalPath(storageKey));
      return true;
    } catch (error: any) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  async getFreeBytes(): Promise<number> {
    await fs.promises.mkdir(this.rootDir, { recursive: true });
    const stats = await fs.promises.statfs(this.rootDir);
    return Number(stats.bavail) * Number(stats.bsize);
  }
}

export const publicSiteAssetStorageService = new PublicSiteAssetStorageService();
