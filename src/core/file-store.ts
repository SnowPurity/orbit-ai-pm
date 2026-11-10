import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface StoredFile {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
}

const SAFE_KEY = /^[A-Za-z0-9_-]+$/;

export function sanitizeFilename(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim();
  return (cleaned.slice(0, 200) || 'attachment');
}

export class FileStore {
  readonly objectsDir: string;
  readonly tmpDir: string;

  constructor(readonly baseDir: string) {
    this.objectsDir = path.join(baseDir, 'objects');
    this.tmpDir = path.join(baseDir, 'tmp');
    // Uploads stay private to the service account.
    for (const dir of [baseDir, this.objectsDir, this.tmpDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    this.cleanupTemp();
  }

  pathFor(storageKey: string): string {
    if (!SAFE_KEY.test(storageKey)) {
      throw new Error(`Invalid storage key: ${storageKey}`);
    }
    const shard = storageKey.slice(-2);
    return path.join(this.objectsDir, shard, storageKey);
  }

  async save(storageKey: string, stream: Readable): Promise<StoredFile> {
    const finalPath = this.pathFor(storageKey);
    const tempPath = path.join(this.tmpDir, `${storageKey}.part`);
    const hash = createHash('sha256');
    let sizeBytes = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        sizeBytes += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await fs.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
      await pipeline(stream, meter, createWriteStream(tempPath, { mode: 0o600 }));
      await fs.rename(tempPath, finalPath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
    return { storageKey, sizeBytes, sha256: hash.digest('hex') };
  }

  async remove(storageKey: string): Promise<void> {
    await fs.rm(this.pathFor(storageKey), { force: true }).catch(() => {});
  }

  async stat(storageKey: string): Promise<{ size: number } | null> {
    try {
      const info = await fs.stat(this.pathFor(storageKey));
      return info.isFile() ? { size: info.size } : null;
    } catch {
      return null;
    }
  }

  private cleanupTemp(): void {
    const maxAgeMs = 60 * 60 * 1000;
    void fs
      .readdir(this.tmpDir)
      .then(async (entries) => {
        await Promise.all(
          entries
            .filter((entry) => entry.endsWith('.part'))
            .map(async (entry) => {
              const file = path.join(this.tmpDir, entry);
              const info = await fs.stat(file).catch(() => null);
              if (info && Date.now() - info.mtimeMs > maxAgeMs) {
                await fs.rm(file, { force: true }).catch(() => {});
              }
            }),
        );
      })
      .catch(() => {});
  }
}
