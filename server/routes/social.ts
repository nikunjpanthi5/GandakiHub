import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { type AuthenticatedRequest, requireAuth } from '../authMiddleware.ts';
import { createNotification } from '../db.ts';

function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function createSocialRouter(db: DatabaseSync): Router {
  const router = Router();

  // Discover people to connect with (never leaks private emails or private connection lists)
  router.get('/people', requireAuth, (req: AuthenticatedRequest, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const viewerId = req.user!.id;

    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio, u.role,
                u.university_email_verified, u.program_id, u.semester_id, u.privacy_settings_json,
                p.name as program_name, s.name as semester_name
         FROM users u
         LEFT JOIN programs p ON p.id = u.program_id
         LEFT JOIN semesters s ON s.id = u.semester_id
         WHERE u.id != ? AND u.account_status = 'active'
           AND u.role NOT IN ('admin', 'super_admin')
           AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE (ub.blocker_id = ? AND ub.blocked_id = u.id) OR (ub.blocker_id = u.id AND ub.blocked_id = ?))
           ${q ? 'AND (lower(u.display_name) LIKE ? OR lower(u.username) LIKE ? OR lower(u.bio) LIKE ?)' : ''}
         ORDER BY u.university_email_verified DESC, u.created_at DESC
         LIMIT 40`
      )
      .all(...(q ? [viewerId, viewerId, viewerId, `%${q}%`, `%${q}%`, `%${q}%`] : [viewerId, viewerId, viewerId])) as Record<string, unknown>[];

    const people = rows.map((r) => {
      const [ua, ub] = canonicalPair(viewerId, String(r.id));
      const connected = Boolean(
        db.prepare('SELECT 1 FROM connections WHERE user_a_id = ? AND user_b_id = ?').get(ua, ub)
      );
      const pendingReq = db
        .prepare(
          "SELECT id, sender_id FROM connection_requests WHERE status = 'pending' AND ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))"
        )
        .get(viewerId, String(r.id), String(r.id), viewerId) as { id: string; sender_id: string } | undefined;

      const privacy = JSON.parse(String(r.privacy_settings_json || '{"show_program":true,"allow_connection_requests":true}'));
      return {
        id: r.id,
        username: r.username,
        display_name: r.display_name,
        avatar_url: r.avatar_url,
        bio: r.bio,
        role: r.role,
        university_email_verified: Boolean(r.university_email_verified),
        program_name: privacy.show_program ? r.program_name : null,
        semester_name: privacy.show_program ? r.semester_name : null,
        allow_connection_requests: Boolean(privacy.allow_connection_requests ?? true),
        connection_status: connected
          ? 'connected'
          : pendingReq
            ? pendingReq.sender_id === viewerId
              ? 'outgoing_pending'
              : 'incoming_pending'
            : 'none',
        pending_request_id: pendingReq?.id ?? null,
      };
    });

    return res.json({ people });
  });

  // Private list of OWN connections & requests ONLY
  router.get('/connections', requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.user!.id;

    const conns = db
      .prepare(
        `SELECT c.id as connection_id, c.created_at,
                u.id as peer_id, u.username, u.display_name, u.avatar_url, u.bio, u.role, u.university_email_verified,
                p.name as program_name, s.name as semester_name
         FROM connections c
         JOIN users u ON u.id = (CASE WHEN c.user_a_id = ? THEN c.user_b_id ELSE c.user_a_id END)
         LEFT JOIN programs p ON p.id = u.program_id
         LEFT JOIN semesters s ON s.id = u.semester_id
         WHERE (c.user_a_id = ? OR c.user_b_id = ?) AND u.role NOT IN ('admin', 'super_admin')
         ORDER BY c.created_at DESC`
      )
      .all(uid, uid, uid) as Record<string, unknown>[];

    const incoming = db
      .prepare(
        `SELECT cr.id, cr.note, cr.status, cr.created_at,
                u.id as peer_id, u.username, u.display_name, u.avatar_url, u.bio, u.role, u.university_email_verified
         FROM connection_requests cr
         JOIN users u ON u.id = cr.sender_id
         WHERE cr.receiver_id = ? AND cr.status = 'pending' AND u.role NOT IN ('admin', 'super_admin')
         ORDER BY cr.created_at DESC`
      )
      .all(uid) as Record<string, unknown>[];

    const outgoing = db
      .prepare(
        `SELECT cr.id, cr.note, cr.status, cr.created_at,
                u.id as peer_id, u.username, u.display_name, u.avatar_url, u.bio, u.role, u.university_email_verified
         FROM connection_requests cr
         JOIN users u ON u.id = cr.receiver_id
         WHERE cr.sender_id = ? AND cr.status = 'pending' AND u.role NOT IN ('admin', 'super_admin')
         ORDER BY cr.created_at DESC`
      )
      .all(uid) as Record<string, unknown>[];

    const blocked = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, ub.created_at
         FROM user_blocks ub JOIN users u ON u.id = ub.blocked_id
         WHERE ub.blocker_id = ?`
      )
      .all(uid);

    return res.json({
      connections: conns.map((c) => ({
        connection_id: c.connection_id,
        created_at: c.created_at,
        peer: {
          id: c.peer_id,
          username: c.username,
          display_name: c.display_name,
          avatar_url: c.avatar_url,
          bio: c.bio,
          role: c.role,
          university_email_verified: Boolean(c.university_email_verified),
          program_name: c.program_name,
          semester_name: c.semester_name,
        },
      })),
      incoming: incoming.map((r) => ({
        id: r.id,
        direction: 'incoming',
        note: r.note,
        status: r.status,
        created_at: r.created_at,
        peer: {
          id: r.peer_id,
          username: r.username,
          display_name: r.display_name,
          avatar_url: r.avatar_url,
          bio: r.bio,
          role: r.role,
          university_email_verified: Boolean(r.university_email_verified),
        },
      })),
      outgoing: outgoing.map((r) => ({
        id: r.id,
        direction: 'outgoing',
        note: r.note,
        status: r.status,
        created_at: r.created_at,
        peer: {
          id: r.peer_id,
          username: r.username,
          display_name: r.display_name,
          avatar_url: r.avatar_url,
          bio: r.bio,
          role: r.role,
          university_email_verified: Boolean(r.university_email_verified),
        },
      })),
      blocked,
    });
  });

  router.post('/connections/request', requireAuth, (req: AuthenticatedRequest, res) => {
    if (req.user!.role === 'visitor') {
      return res.status(403).json({ error: 'Visitors cannot send connection requests.' });
    }
    const parsed = z
      .object({
        receiver_id: z.string().min(1),
        note: z.string().max(240).default(''),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid connection request.' });

    const senderId = req.user!.id;
    const receiverId = parsed.data.receiver_id;

    if (senderId === receiverId) {
      return res.status(400).json({ error: 'You cannot send a connection request to yourself.' });
    }

    if (req.user!.role === 'admin' || req.user!.role === 'super_admin') {
      return res.status(403).json({ error: 'Administrator accounts do not participate in peer connections.' });
    }

    const receiver = db
      .prepare('SELECT id, role, privacy_settings_json, account_status FROM users WHERE id = ?')
      .get(receiverId) as { id: string; role: string; privacy_settings_json: string; account_status: string } | undefined;
    if (!receiver || receiver.account_status !== 'active') {
      return res.status(404).json({ error: 'Target user not found.' });
    }
    if (receiver.role === 'admin' || receiver.role === 'super_admin') {
      return res.status(403).json({ error: 'Administrator accounts are not visible or connectable in Connections.' });
    }

    const blocked = db
      .prepare('SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)')
      .get(senderId, receiverId, receiverId, senderId);
    if (blocked) {
      return res.status(403).json({ error: 'Connection unavailable due to block settings.' });
    }

    const [ua, ub] = canonicalPair(senderId, receiverId);
    const alreadyConnected = db.prepare('SELECT 1 FROM connections WHERE user_a_id = ? AND user_b_id = ?').get(ua, ub);
    if (alreadyConnected) {
      return res.status(409).json({ error: 'You are already connected with this user.' });
    }

    const pending = db
      .prepare(
        "SELECT 1 FROM connection_requests WHERE status = 'pending' AND ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))"
      )
      .get(senderId, receiverId, receiverId, senderId);
    if (pending) {
      return res.status(409).json({ error: 'A pending connection request already exists between you and this user.' });
    }

    const id = `creq-${crypto.randomUUID().slice(0, 10)}`;
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO connection_requests (id, sender_id, receiver_id, note, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)"
    ).run(id, senderId, receiverId, parsed.data.note.trim(), now, now);

    createNotification(
      db,
      receiverId,
      'connection_request',
      'New Connection Request',
      `${req.user!.display_name} wants to connect with you.`,
      '/connections'
    );

    return res.status(201).json({ id, status: 'pending' });
  });

  router.post('/connections/requests/:id/respond', requireAuth, (req: AuthenticatedRequest, res) => {
    const { action } = z.object({ action: z.enum(['accept', 'reject', 'cancel']) }).parse(req.body);
    const reqRow = db.prepare('SELECT * FROM connection_requests WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!reqRow || String(reqRow.status) !== 'pending') {
      return res.status(404).json({ error: 'Pending connection request not found.' });
    }

    const uid = req.user!.id;
    const senderId = String(reqRow.sender_id);
    const receiverId = String(reqRow.receiver_id);

    if (action === 'cancel') {
      if (senderId !== uid) return res.status(403).json({ error: 'Only the sender can cancel an outgoing request.' });
      db.prepare("UPDATE connection_requests SET status = 'cancelled', updated_at = ? WHERE id = ?").run(new Date().toISOString(), req.params.id);
      return res.json({ status: 'cancelled' });
    }

    if (receiverId !== uid) {
      return res.status(403).json({ error: 'Only the recipient can accept or reject this request.' });
    }

    const now = new Date().toISOString();
    if (action === 'reject') {
      db.prepare("UPDATE connection_requests SET status = 'rejected', updated_at = ? WHERE id = ?").run(now, req.params.id);
      return res.json({ status: 'rejected' });
    }

    db.exec('BEGIN');
    try {
      db.prepare("UPDATE connection_requests SET status = 'accepted', updated_at = ? WHERE id = ?").run(now, req.params.id);
      const [ua, ub] = canonicalPair(senderId, receiverId);
      db.prepare('INSERT OR IGNORE INTO connections (id, user_a_id, user_b_id, created_at) VALUES (?, ?, ?, ?)').run(
        `conn-${crypto.randomUUID().slice(0, 10)}`,
        ua,
        ub,
        now
      );
      createNotification(
        db,
        senderId,
        'connection_accepted',
        'Connection Request Accepted',
        `${req.user!.display_name} accepted your connection request.`,
        '/connections'
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return res.json({ status: 'accepted' });
  });

  router.delete('/connections/:connectionId', requireAuth, (req: AuthenticatedRequest, res) => {
    const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(req.params.connectionId) as Record<string, unknown> | undefined;
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });
    if (String(conn.user_a_id) !== req.user!.id && String(conn.user_b_id) !== req.user!.id) {
      return res.status(403).json({ error: 'Unauthorized to remove this connection.' });
    }
    db.prepare('DELETE FROM connections WHERE id = ?').run(req.params.connectionId);
    return res.json({ ok: true });
  });

  router.post('/users/:targetId/block', requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.user!.id;
    const targetId = req.params.targetId;
    if (uid === targetId) return res.status(400).json({ error: 'You cannot block yourself.' });

    const existing = db.prepare('SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?').get(uid, targetId);
    if (existing) {
      db.prepare('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?').run(uid, targetId);
      return res.json({ blocked: false });
    }

    const [ua, ub] = canonicalPair(uid, targetId);
    db.prepare('INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').run(uid, targetId, new Date().toISOString());
    db.prepare('DELETE FROM connections WHERE user_a_id = ? AND user_b_id = ?').run(ua, ub);
    db.prepare(
      "UPDATE connection_requests SET status = 'cancelled' WHERE status = 'pending' AND ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))"
    ).run(uid, targetId, targetId, uid);
    return res.json({ blocked: true });
  });

  // Notifications
  router.get('/notifications', requireAuth, (req: AuthenticatedRequest, res) => {
    const items = db
      .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
      .all(req.user!.id) as Record<string, unknown>[];
    const unreadRow = db
      .prepare('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0')
      .get(req.user!.id) as { cnt: number };

    return res.json({
      notifications: items.map((n) => ({ ...n, is_read: Boolean(n.is_read) })),
      unread_count: Number(unreadRow.cnt),
    });
  });

  router.post('/notifications/:id/read', requireAuth, (req: AuthenticatedRequest, res) => {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user!.id);
    return res.json({ ok: true });
  });

  router.post('/notifications/read-all', requireAuth, (req: AuthenticatedRequest, res) => {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user!.id);
    return res.json({ ok: true });
  });

  // Private Messaging status (honest In Development architecture endpoint — zero plaintext storage!)
  router.get('/messages/status', (_req, res) => {
    return res.json({
      status: 'currently_in_development',
      e2ee_enabled: false,
      planned_protocol: 'Matrix Olm/Megolm End-to-End Encryption',
      notice:
        'Private encrypted messaging is currently in development. GandakiHub intentionally does not store plaintext messages or claim end-to-end encryption prior to independent protocol verification.',
    });
  });

  return router;
}
