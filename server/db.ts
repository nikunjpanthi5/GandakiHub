import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';

export type QueryResultRow = Record<string, unknown>;

export interface DbExecutor {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<number>;
}

export interface AppDatabase extends DbExecutor {
  kind: 'postgres' | 'pglite';
  transaction<T>(fn: (tx: DbExecutor) => Promise<T>, options?: { trustedServer?: boolean; actorId?: string | null }): Promise<T>;
  close(): Promise<void>;
}

function createPgPoolExecutor(client: Pool | PoolClient): DbExecutor {
  return {
    async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
      const result = await client.query(sql, params);
      return result.rows as T[];
    },
    async queryOne<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | null> {
      const result = await client.query(sql, params);
      return (result.rows[0] as T | undefined) ?? null;
    },
    async execute(sql: string, params: unknown[] = []): Promise<number> {
      const result = await client.query(sql, params);
      return result.rowCount ?? 0;
    },
  };
}

export function createPgPoolDatabase(connectionString: string): AppDatabase {
  const isLocal =
    connectionString.includes('localhost') ||
    connectionString.includes('127.0.0.1') ||
    process.env.PGSSLMODE === 'disable';

  const pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
  });

  pool.on('error', (err) => {
    console.error('[GandakiHub PG Pool Error]', err.message);
  });

  const rootExec = createPgPoolExecutor(pool);

  return {
    kind: 'postgres',
    ...rootExec,
    async transaction<T>(
      fn: (tx: DbExecutor) => Promise<T>,
      options: { trustedServer?: boolean; actorId?: string | null } = {}
    ): Promise<T> {
      const client = await pool.connect();
      const txExec = createPgPoolExecutor(client);
      try {
        await client.query('BEGIN');
        if (options.trustedServer) {
          await client.query("SELECT set_config('app.trusted_server', 'true', true)");
        }
        if (options.actorId) {
          await client.query("SELECT set_config('app.current_user_id', $1, true)", [options.actorId]);
        }
        const out = await fn(txExec);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback error
        }
        throw err;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

export interface PGliteLike {
  query<T = QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

export function createPGliteDatabase(pg: PGliteLike): AppDatabase {
  let txQueue = Promise.resolve();

  function runSerialized<T>(work: () => Promise<T>): Promise<T> {
    const next = txQueue.then(work, work);
    txQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  const exec: DbExecutor = {
    async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
      const res = await pg.query<T>(sql, params);
      return res.rows;
    },
    async queryOne<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | null> {
      const res = await pg.query<T>(sql, params);
      return res.rows[0] ?? null;
    },
    async execute(sql: string, params: unknown[] = []): Promise<number> {
      const res = await pg.query(sql, params);
      return res.affectedRows ?? res.rows.length ?? 0;
    },
  };

  return {
    kind: 'pglite',
    ...exec,
    async transaction<T>(
      fn: (tx: DbExecutor) => Promise<T>,
      options: { trustedServer?: boolean; actorId?: string | null } = {}
    ): Promise<T> {
      return runSerialized(async () => {
        await pg.exec('BEGIN');
        try {
          if (options.trustedServer) {
            await pg.query("SELECT set_config('app.trusted_server', 'true', true)");
          }
          if (options.actorId) {
            await pg.query("SELECT set_config('app.current_user_id', $1, true)", [options.actorId]);
          }
          const out = await fn(exec);
          await pg.exec('COMMIT');
          return out;
        } catch (err) {
          try {
            await pg.exec('ROLLBACK');
          } catch {
            // ignore
          }
          throw err;
        }
      });
    },
    async close(): Promise<void> {
      await pg.close();
    },
  };
}

let cachedDb: AppDatabase | null = null;

export async function initDatabase(): Promise<AppDatabase> {
  if (cachedDb) return cachedDb;

  const databaseUrl = process.env.DATABASE_URL?.trim();
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd && !databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required in production (Supabase PostgreSQL connection string).');
  }

  if (databaseUrl) {
    const db = createPgPoolDatabase(databaseUrl);
    await db.queryOne('SELECT 1 AS ok');
    const schemaCheck = await db.queryOne<{ exists: string | null }>(
      "SELECT to_regclass('public.profiles')::text AS exists"
    );
    if (!schemaCheck?.exists) {
      throw new Error(
        'PostgreSQL schema is not initialized. Run supabase/migrations/002_complete_production_schema.sql and supabase/seed.sql in your Supabase SQL Editor first.'
      );
    }
    cachedDb = db;
    return db;
  }

  // Non-production local development without DATABASE_URL: use real embedded PostgreSQL (PGlite)
  // so local dev preview runs the exact same PostgreSQL schema & queries with zero SQLite.
  console.warn(
    '[GandakiHub] DATABASE_URL not set in local dev. Starting embedded local PostgreSQL (PGlite). Set DATABASE_URL for Supabase PostgreSQL.'
  );
  const { PGlite } = await import('@electric-sql/pglite');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const pgDataDir = process.env.LOCAL_PGDATA_DIR || path.resolve(process.cwd(), 'data', 'pgdata');
  fs.mkdirSync(path.dirname(pgDataDir), { recursive: true });
  const pglite = new PGlite(pgDataDir, { extensions: { pg_trgm } });

  const migrationSql = fs.readFileSync(
    path.resolve(process.cwd(), 'supabase', 'migrations', '002_complete_production_schema.sql'),
    'utf8'
  );
  await pglite.exec(migrationSql);

  const db = createPGliteDatabase(pglite);
  cachedDb = db;
  return db;
}

export async function writeAuditLog(
  db: DbExecutor,
  actorId: string | null,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await db.execute(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())`,
    [crypto.randomUUID(), actorId, action, targetType, targetId, JSON.stringify(metadata)]
  );
}

export async function createNotification(
  db: DbExecutor,
  userId: string,
  kind: string,
  title: string,
  body: string,
  linkPath: string
): Promise<void> {
  await db.execute(
    `INSERT INTO notifications (id, user_id, kind, title, body, link_path, is_read, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, FALSE, NOW())`,
    [crypto.randomUUID(), userId, kind, title, body, linkPath]
  );
}

export async function syncModerationQueue(
  db: DbExecutor,
  entityType: string,
  entityId: string,
  submittedBy: string | null,
  status: 'pending' | 'approved' | 'rejected' | 'changes_requested',
  reviewerId: string | null = null,
  notes: string | null = null
): Promise<void> {
  await db.execute(
    `INSERT INTO moderation_queue (id, entity_type, entity_id, submitted_by, status, reviewer_id, notes, created_at, reviewed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), CASE WHEN $5 = 'pending' THEN NULL ELSE NOW() END)
     ON CONFLICT (entity_type, entity_id) DO UPDATE SET
       status = EXCLUDED.status,
       reviewer_id = EXCLUDED.reviewer_id,
       notes = EXCLUDED.notes,
       reviewed_at = CASE WHEN EXCLUDED.status = 'pending' THEN NULL ELSE NOW() END`,
    [crypto.randomUUID(), entityType, entityId, submittedBy, status, reviewerId, notes]
  );
}
