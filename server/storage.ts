import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface StorageService {
  kind: 'supabase' | 'memory';
  bucket: string;
  uploadPrivate(objectPath: string, buffer: Buffer, contentType: string): Promise<void>;
  downloadPrivate(objectPath: string): Promise<Buffer | null>;
  createSignedUrl(objectPath: string, expiresInSeconds?: number, downloadFilename?: string): Promise<string | null>;
  deletePrivate(objectPath: string): Promise<void>;
}

export function createSupabaseStorage(
  supabaseUrl: string,
  serviceRoleKey: string,
  bucket = process.env.SUPABASE_STORAGE_BUCKET || 'gandakihub-private'
): StorageService {
  const client: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    kind: 'supabase',
    bucket,
    async uploadPrivate(objectPath: string, buffer: Buffer, contentType: string): Promise<void> {
      const { error } = await client.storage.from(bucket).upload(objectPath, buffer, {
        contentType,
        upsert: false,
      });
      if (error) {
        throw new Error(`Supabase Storage upload failed: ${error.message}`);
      }
    },
    async downloadPrivate(objectPath: string): Promise<Buffer | null> {
      const { data, error } = await client.storage.from(bucket).download(objectPath);
      if (error || !data) {
        return null;
      }
      const ab = await data.arrayBuffer();
      return Buffer.from(ab);
    },
    async createSignedUrl(
      objectPath: string,
      expiresInSeconds = 60,
      downloadFilename?: string
    ): Promise<string | null> {
      const { data, error } = await client.storage
        .from(bucket)
        .createSignedUrl(objectPath, expiresInSeconds, downloadFilename ? { download: downloadFilename } : undefined);
      if (error || !data?.signedUrl) {
        return null;
      }
      return data.signedUrl;
    },
    async deletePrivate(objectPath: string): Promise<void> {
      await client.storage.from(bucket).remove([objectPath]);
    },
  };
}

export function createMemoryStorage(): StorageService {
  const objects = new Map<string, { buffer: Buffer; contentType: string }>();

  return {
    kind: 'memory',
    bucket: 'memory-private-test',
    async uploadPrivate(objectPath: string, buffer: Buffer, contentType: string): Promise<void> {
      objects.set(objectPath, { buffer: Buffer.from(buffer), contentType });
    },
    async downloadPrivate(objectPath: string): Promise<Buffer | null> {
      const entry = objects.get(objectPath);
      return entry ? Buffer.from(entry.buffer) : null;
    },
    async createSignedUrl(objectPath: string, expiresInSeconds = 60): Promise<string | null> {
      if (!objects.has(objectPath)) return null;
      const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
      return `https://memory-signed.local/${encodeURIComponent(objectPath)}?exp=${exp}`;
    },
    async deletePrivate(objectPath: string): Promise<void> {
      objects.delete(objectPath);
    },
  };
}

let cachedStorage: StorageService | null = null;

export function initStorage(): StorageService {
  if (cachedStorage) return cachedStorage;

  const supabaseUrl = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const bucket = (process.env.SUPABASE_STORAGE_BUCKET || 'gandakihub-private').trim();
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd && (!supabaseUrl || !serviceRoleKey)) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production for private Supabase Storage.'
    );
  }

  if (supabaseUrl && serviceRoleKey) {
    cachedStorage = createSupabaseStorage(supabaseUrl, serviceRoleKey, bucket);
    return cachedStorage;
  }

  console.warn(
    '[GandakiHub] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set in local dev. Using ephemeral memory storage. Configure Supabase Storage for persistence.'
  );
  cachedStorage = createMemoryStorage();
  return cachedStorage;
}
