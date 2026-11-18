import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { type AuthenticatedRequest, requireAuth } from '../authMiddleware.ts';
import { getMediaDir } from '../db.ts';

function detectImageExtension(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return { ext: 'png', mime: 'image/png' };
  }
  if (buf.subarray(0, 3).toString('hex') === 'ffd8ff') {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') {
    return { ext: 'gif', mime: 'image/gif' };
  }
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

export function createMediaRouter(): Router {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
  });

  router.post('/media/upload', requireAuth, upload.single('image'), (req: AuthenticatedRequest, res) => {
    if (req.user!.role === 'visitor') {
      return res.status(403).json({ error: 'Visitors cannot upload post images.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Please select an image file (PNG, JPEG, WebP, or GIF, max 5 MB).' });
    }

    const detected = detectImageExtension(req.file.buffer);
    if (!detected) {
      return res.status(400).json({ error: 'Only valid PNG, JPEG, WebP, or GIF images are permitted.' });
    }

    const mediaDir = getMediaDir();
    fs.mkdirSync(mediaDir, { recursive: true });
    const filename = `${Date.now()}_${crypto.randomUUID().slice(0, 12)}.${detected.ext}`;
    fs.writeFileSync(path.join(mediaDir, filename), req.file.buffer);

    return res.status(201).json({
      image_url: `/api/media/images/${filename}`,
      mime: detected.mime,
      size: req.file.size,
    });
  });

  router.get('/media/images/:filename', (req, res) => {
    const safe = path.basename(req.params.filename);
    if (!/^[a-zA-Z0-9._-]+$/.test(safe)) {
      return res.status(400).end();
    }
    const full = path.join(getMediaDir(), safe);
    if (!fs.existsSync(full)) {
      return res.status(404).end();
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(full);
  });

  return router;
}
