import { FlatCacheProvider } from '@abextm/cache2';
import * as fs from 'fs/promises';
import * as path from 'path';

const CACHE_DIR = './osrs-cache';

interface FileProvider {
  getFile(name: string): Promise<Uint8Array | undefined>;
  exists(name: string): Promise<boolean>;
}

async function createFileProvider(): Promise<FileProvider> {
  return {
    async getFile(name: string): Promise<Uint8Array | undefined> {
      try {
        const filePath = path.join(CACHE_DIR, name);
        const data = await fs.readFile(filePath);
        return new Uint8Array(data);
      } catch (err) {
        return undefined;
      }
    },

    async exists(name: string): Promise<boolean> {
      try {
        const filePath = path.join(CACHE_DIR, name);
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export async function createCacheProvider(): Promise<FlatCacheProvider> {
  const fileProvider = await createFileProvider();
  return new FlatCacheProvider(fileProvider);
}
