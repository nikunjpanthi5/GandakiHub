import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { type AuthenticatedRequest, requireAuth } from '../authMiddleware.ts';
import { type AppDatabase, createNotification } from '../db.ts';
import { isUuid } from '../security.ts';

function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function createSocialRouter(db: AppDatabase): Router {
  const router = Router();

  // Discover people to connect with (never leaks admins, private emails, or connection lists)
  router.get('/people', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase();
      const viewerId = req.user!.id;

      const rows = await db.query<Record<string, unknown>>(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio, u.role,
                u.university_email_verified, u.program_id, u.semester_id, u.privacy_settings,
                p.name AS program_name, s.name AS semester_name
         FROM profiles u
         LEFT JOIN programs p ON p.id = u.program_id
         LEFT JOIN semesters s ON s.id = u.semester_id
         WHERE u.id <> $1 AND u.account_status = 'active'
           AND u.role NOT IN ('admin', 'super_admin')
           AND NOT EXISTS (
             SELECT 1 FROM user_blocks ub
             WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id) OR (ub.blocker_id = u.id AND ub.blocked_id = $1)
           )
           ${q ? 'AND (lower(u.display_name) LIKE $2 OR lower(u.username) LIKE $2 OR lower(u.bio) LIKE $2)' : ''}
         ORDER BY u.university_email_verified DESC, u.created_at DESC
         LIMIT 40`,
        q ? [viewerId, `%${q}%`] : [viewerId]
      );

      const [myConns, myPending] = await Promise.all([
        db.query<{ user_a_id: string; user_b_id: string }>(
          'SELECT user_a_id, user_b_id FROM connections WHERE user_a_id = $1 OR user_b_id = $1',
          [viewerId]
        ),
        db.query<{ id: string; sender_id: string; receiver_id: string }>(
          "SELECT id, sender_id, receiver_id FROM connection_requests WHERE status = 'pending' AND (sender_id = $1 OR receiver_id = $1)",
          [viewerId]
        ),
      ]);

      const connPeerSet = new Set<string>();
      for (const c of myConns) {
        connPeerSet.add(String(c.user_a_id) === viewerId ? String(c.user_b_id) : String(c.user_a_id));
      }
      const pendingByPeer = new Map<string, { id: string; sender_id: string }>();
      for (const pr of myPending) {
        const peer = String(pr.sender_id) === viewerId ? String(pr.receiver_id) : String(pr.sender_id);
        pendingByPeer.set(peer, { id: String(pr.id), sender_id: String(pr.sender_id) });
      }

      const people = rows.map((r) => {
        const pid = String(r.id);
        const connected = connPeerSet.has(pid);
        const pendingReq = pendingByPeer.get(pid);
        const privacy = (r.privacy_settings as { show_program?: boolean; allow_connection_requests?: boolean }) || {
          show_program: true,
          allow_connection_requests: true,
        };

        return {
          id: pid,
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
    } catch (err) {
      return next(err);
    }
  });

  // Private list of OWN connections & requests ONLY
  router.get('/connections', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = req.user!.id;

      const [conns, incoming, outgoing, blocked] = await Promise.all([
        db.query<Record<string, unknown>>(
          `SELECT c.id AS connection_id, c.created_at,
                  u.id AS peer_id, u.username, u.display_name, u.avatar_url, u.bio, u.role, u.university_email_verified,
                  p.name AS program_name, s.name AS semester_name
           FROM connections c
           JOIN profiles u ON u.id = (CASE WHEN c.user_a_id = $1 THEN c.user_b_id ELSE c.user_a_id END)
           LEFT JOIN programs p ON p.id = u.program_id
           LEFT JOIN semesters s ON s.id = u.semester_id
           WHERE (c.user_a_id = $1 OR c.user_b_id = $1) AND u.role NOT IN ('admin', 'super_admin')
           ORDER BY c.created_at DESC`,
          [uid]
        ),
        db.query<Record<string, unknown>>(
          `SELECT cr.id, cr.note, cr.status, cr.created_at,
                  u.id AS peer_id, u.username, u.display_name, u.avatar_url, u.bio, u.role, u.university_email_verified
           FROM connection_requests cr
           JOIN profiles u ON u.id = cr.sender_id
           WHERE cr.receiver_id = $1 AND cr.status = 'pending' AND u.role NOT IN ('admin', 'super_admin')
           ORDER BY cr.created_at DESC`,
          [uid]
        ),
        db.query<Record<string, unknown>>(
          `SELECT cr.id, cr.note, cr.status, cr.created_at,
                  u.id AS peer_id, u.username, u.display_name, u.avatar_url, u.bio, u.role, u.university_email_verified
           FROM connection_requests cr
           JOIN profiles u ON u.id = cr.receiver_id
           WHERE cr.sender_id = $1 AND cr.status = 'pending' AND u.role NOT IN ('admin', 'super_admin')
           ORDER BY cr.created_at DESC`,
          [uid]
        ),
        db.query(
          `SELECT u.id, u.username, u.display_name, ub.created_at
           FROM user_blocks ub JOIN profiles u ON u.id = ub.blocked_id
           WHERE ub.blocker_id = $1`,
          [uid]
        ),
      ]);

      return res.json({
        connections: conns.map((c) => ({
          connection_id: c.connection_id,
          created_at: new Date(String(c.created_at)).toISOString(),
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
          created_at: new Date(String(r.created_at)).toISOString(),
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
          created_at: new Date(String(r.created_at)).toISOString(),
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
    } catch (err) {
      return next(err);
    }
  });

  router.post('/connections/request', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (req.user!.role === 'visitor') {
        return res.status(403).json({ error: 'Visitors cannot send connection requests.' });
      }
      const parsed = z
        .object({
          receiver_id: z.string().min(1),
          note: z.string().max(240).default(''),
        })
        .safeParse(req.body);
      if (!parsed.success || !isUuid(parsed.data.receiver_id)) {
        return res.status(400).json({ error: 'Invalid connection request.' });
      }

      const senderId = req.user!.id;
      const receiverId = parsed.data.receiver_id;

      if (senderId === receiverId) {
        return res.status(400).json({ error: 'You cannot send a connection request to yourself.' });
      }

      if (req.user!.role === 'admin' || req.user!.role === 'super_admin') {
        return res.status(403).json({ error: 'Administrator accounts do not participate in peer connections.' });
      }

      const receiver = await db.queryOne<{
        id: string;
        role: string;
        account_status: string;
      }>('SELECT id, role, account_status FROM profiles WHERE id = $1', [receiverId]);

      if (!receiver || receiver.account_status !== 'active') {
        return res.status(404).json({ error: 'Target user not found.' });
      }
      if (receiver.role === 'admin' || receiver.role === 'super_admin') {
        return res.status(403).json({ error: 'Administrator accounts are not visible or connectable in Connections.' });
      }

      const blocked = await db.queryOne(
        'SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)',
        [senderId, receiverId]
      );
      if (blocked) {
        return res.status(403).json({ error: 'Connection unavailable due to block settings.' });
      }

      const [ua, ub] = canonicalPair(senderId, receiverId);
      const alreadyConnected = await db.queryOne(
        'SELECT 1 FROM connections WHERE user_a_id = $1 AND user_b_id = $2',
        [ua, ub]
      );
      if (alreadyConnected) {
        return res.status(409).json({ error: 'You are already connected with this user.' });
      }

      const pending = await db.queryOne(
        "SELECT 1 FROM connection_requests WHERE status = 'pending' AND ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))",
        [senderId, receiverId]
      );
      if (pending) {
        return res.status(409).json({ error: 'A pending connection request already exists between you and this user.' });
      }

      const id = crypto.randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(
          "INSERT INTO connection_requests (id, sender_id, receiver_id, note, status, created_at, updated_at) VALUES ($1, $2, $3, $4, 'pending', NOW(), NOW())",
          [id, senderId, receiverId, parsed.data.note.trim()]
        );

        await createNotification(
          tx,
          receiverId,
          'connection_request',
          'New Connection Request',
          `${req.user!.display_name} wants to connect with you.`,
          '/connections'
        );
      });

      return res.status(201).json({ id, status: 'pending' });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/connections/requests/:id/respond', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Pending connection request not found.' });
      const parsed = z.object({ action: z.enum(['accept', 'reject', 'cancel']) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid action.' });
      const { action } = parsed.data;

      const reqRow = await db.queryOne<Record<string, unknown>>(
        'SELECT * FROM connection_requests WHERE id = $1',
        [req.params.id]
      );
      if (!reqRow || String(reqRow.status) !== 'pending') {
        return res.status(404).json({ error: 'Pending connection request not found.' });
      }

      const uid = req.user!.id;
      const senderId = String(reqRow.sender_id);
      const receiverId = String(reqRow.receiver_id);

      if (action === 'cancel') {
        if (senderId !== uid) return res.status(403).json({ error: 'Only the sender can cancel an outgoing request.' });
        await db.execute("UPDATE connection_requests SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [
          req.params.id,
        ]);
        return res.json({ status: 'cancelled' });
      }

      if (receiverId !== uid) {
        return res.status(403).json({ error: 'Only the recipient can accept or reject this request.' });
      }

      if (action === 'reject') {
        await db.execute("UPDATE connection_requests SET status = 'rejected', updated_at = NOW() WHERE id = $1", [
          req.params.id,
        ]);
        return res.json({ status: 'rejected' });
      }

      await db.transaction(async (tx) => {
        await tx.execute("UPDATE connection_requests SET status = 'accepted', updated_at = NOW() WHERE id = $1", [
          req.params.id,
        ]);
        const [ua, ub] = canonicalPair(senderId, receiverId);
        await tx.execute(
          'INSERT INTO connections (id, user_a_id, user_b_id, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_a_id, user_b_id) DO NOTHING',
          [crypto.randomUUID(), ua, ub]
        );
        await createNotification(
          tx,
          senderId,
          'connection_accepted',
          'Connection Request Accepted',
          `${req.user!.display_name} accepted your connection request.`,
          '/connections'
        );
      });

      return res.json({ status: 'accepted' });
    } catch (err) {
      return next(err);
    }
  });

  router.delete('/connections/:connectionId', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.connectionId)) return res.status(404).json({ error: 'Connection not found.' });
      const conn = await db.queryOne<Record<string, unknown>>('SELECT * FROM connections WHERE id = $1', [
        req.params.connectionId,
      ]);
      if (!conn) return res.status(404).json({ error: 'Connection not found.' });
      if (String(conn.user_a_id) !== req.user!.id && String(conn.user_b_id) !== req.user!.id) {
        return res.status(403).json({ error: 'Unauthorized to remove this connection.' });
      }
      await db.execute('DELETE FROM connections WHERE id = $1', [req.params.connectionId]);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/users/:targetId/block', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.targetId)) return res.status(404).json({ error: 'User not found.' });
      const uid = req.user!.id;
      const targetId = req.params.targetId;
      if (uid === targetId) return res.status(400).json({ error: 'You cannot block yourself.' });

      const existing = await db.queryOne(
        'SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2',
        [uid, targetId]
      );
      if (existing) {
        await db.execute('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [uid, targetId]);
        return res.json({ blocked: false });
      }

      const [ua, ub] = canonicalPair(uid, targetId);
      await db.transaction(async (tx) => {
        await tx.execute('INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES ($1, $2, NOW())', [
          uid,
          targetId,
        ]);
        await tx.execute('DELETE FROM connections WHERE user_a_id = $1 AND user_b_id = $2', [ua, ub]);
        await tx.execute(
          "UPDATE connection_requests SET status = 'cancelled', updated_at = NOW() WHERE status = 'pending' AND ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))",
          [uid, targetId]
        );
      });
      return res.json({ blocked: true });
    } catch (err) {
      return next(err);
    }
  });

  // Notifications
  router.get('/notifications', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      const [items, unreadRow] = await Promise.all([
        db.query<Record<string, unknown>>(
          'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
          [req.user!.id]
        ),
        db.queryOne<{ cnt: string | number }>(
          'SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = $1 AND is_read = FALSE',
          [req.user!.id]
        ),
      ]);

      return res.json({
        notifications: items.map((n) => ({
          ...n,
          is_read: Boolean(n.is_read),
          created_at: new Date(String(n.created_at)).toISOString(),
        })),
        unread_count: Number(unreadRow?.cnt || 0),
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/notifications/:id/read', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Notification not found.' });
      await db.execute('UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2', [
        req.params.id,
        req.user!.id,
      ]);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/notifications/read-all', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      await db.execute('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [req.user!.id]);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
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
