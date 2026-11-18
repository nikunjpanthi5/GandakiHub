import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createApiApp } from './server/app.ts';
import { initDatabase } from './server/db.ts';
import { getSessionSecret } from './server/security.ts';
import { seedIfEmpty } from './server/seed.ts';
import { initStorage } from './server/storage.ts';

async function startServer() {
  // Validate required secrets early in production
  getSessionSecret();

  const db = await initDatabase();
  await seedIfEmpty(db);
  const storage = initStorage();

  const app = createApiApp(db, storage);
  const envPort = Number(process.env.PORT);
  const nginxPort = Number(process.env.NGINX_PORT);
  const defaultAppPort = Number(process.env.DEFAULT_APP_PORT || 3000);
  const port = nginxPort && envPort === nginxPort ? defaultAppPort : envPort || 3000;
  const isProd = process.env.NODE_ENV === 'production';
  const distDir = path.resolve(process.cwd(), 'dist');
  const hasFrontendDist = fs.existsSync(path.join(distDir, 'index.html'));

  if (isProd && hasFrontendDist) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else if (isProd) {
    // Dedicated API backend mode (e.g., Render Free hosting Express while Vercel hosts Vite frontend)
    app.get('/', (_req, res) => {
      res.json({
        service: 'GandakiHub API',
        status: 'ok',
        health: '/api/health',
      });
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const server = app.listen(port, '0.0.0.0', () => {
    console.info(`GandakiHub running on http://0.0.0.0:${port} (db=${db.kind}, storage=${storage.kind})`);
  });

  const shutdown = async (signal: string) => {
    console.info(`Received ${signal}, shutting down GandakiHub gracefully...`);
    server.close(async () => {
      try {
        await db.close();
      } finally {
        process.exit(0);
      }
    });
    setTimeout(() => process.exit(1), 8000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

startServer().catch((err) => {
  console.error('Failed to start GandakiHub server:', err);
  process.exit(1);
});
