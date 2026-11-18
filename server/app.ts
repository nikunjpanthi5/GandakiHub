import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { attachSessionMiddleware } from './authMiddleware.ts';
import { createAcademicRouter } from './routes/academic.ts';
import { createAdminRouter } from './routes/admin.ts';
import { createAuthRouter } from './routes/auth.ts';
import { createCommunityRouter } from './routes/community.ts';
import { createMediaRouter } from './routes/media.ts';
import { createSearchRouter } from './routes/search.ts';
import { createSocialRouter } from './routes/social.ts';
import { createSpecialRouter } from './routes/special.ts';

export function createApiApp(db: DatabaseSync): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(attachSessionMiddleware(db));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'GandakiHub' });
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
