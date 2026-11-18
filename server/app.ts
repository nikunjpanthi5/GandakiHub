import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { attachSessionMiddleware } from './authMiddleware.ts';
import type { AppDatabase } from './db.ts';
import type { StorageService } from './storage.ts';
import { createAcademicRouter } from './routes/academic.ts';
import { createAdminRouter } from './routes/admin.ts';
import { createAuthRouter } from './routes/auth.ts';
import { createCommunityRouter } from './routes/community.ts';
import { createMediaRouter } from './routes/media.ts';
import { createSearchRouter } from './routes/search.ts';
import { createSocialRouter } from './routes/social.ts';
import { createSpecialRouter } from './routes/special.ts';

function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // same-origin or server-to-server / curl
  const configured = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);

  const normalized = origin.replace(/\/$/, '');
  if (configured.includes(normalized)) return true;

  if (process.env.APP_URL && normalized === process.env.APP_URL.trim().replace(/\/$/, '')) {
    return true;
  }

  if (process.env.ALLOW_VERCEL_PREVIEWS === 'true' && /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(normalized)) {
    return true;
  }

  if (process.env.NODE_ENV !== 'production') {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(normalized)) {
      return true;
    }
  }

  return configured.length === 0 && process.env.NODE_ENV !== 'production';
}

export function createApiApp(db: AppDatabase, storage: StorageService): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    })
  );
  app.use(
    cors({
      origin: (origin, callback) => {
        if (isOriginAllowed(origin)) {
          callback(null, true);
        } else {
          callback(new Error(`CORS policy blocked origin: ${origin}`));
        }
      },
      credentials: true,
      exposedHeaders: ['Content-Disposition'],
    })
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(attachSessionMiddleware(db, storage));

  app.get('/api/health', async (_req, res) => {
    try {
      await db.queryOne('SELECT 1 AS ok');
      res.json({
        status: 'ok',
        service: 'GandakiHub',
        database: db.kind,
        storage: storage.kind,
      });
    } catch (err) {
      res.status(503).json({
        status: 'degraded',
        service: 'GandakiHub',
        error: err instanceof Error ? err.message : 'Database unreachable',
      });
    }
  });

  app.use('/api/auth', createAuthRouter(db));
  app.use('/api/academic', createAcademicRouter(db));
  app.use('/api', createMediaRouter());
  app.use('/api', createCommunityRouter(db));
  app.use('/api', createSpecialRouter(db));
  app.use('/api', createSocialRouter(db));
  app.use('/api', createSearchRouter(db));
  app.use('/api/admin', createAdminRouter(db));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[GandakiHub API Error]', err);
    const message = err instanceof Error ? err.message : 'Unexpected server error';
    res.status(500).json({ error: message });
  });

  return app;
}
