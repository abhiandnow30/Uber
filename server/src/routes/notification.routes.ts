import { Router } from 'express';
import { z } from 'zod';
import { objectId, query } from '../middleware/common.js';
import { Notification } from '../models/system.js';

/** The caller's own in-app notifications (persisted; used to re-sync after reconnect). */
export const notificationRouter = Router();

notificationRouter.get('/', async (req, res) => {
  const q = query(
    z.object({
      unreadOnly: z.enum(['true', 'false']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
      since: z.coerce.date().optional(),
    }),
    req,
  );
  const filter: Record<string, unknown> = { user: req.auth!.user._id };
  if (q.unreadOnly === 'true') filter.readAt = null;
  if (q.since) filter.createdAt = { $gt: q.since };
  const [items, total, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({ user: req.auth!.user._id, readAt: null }),
  ]);
  res.json({ items, total, unread, page: q.page, pageSize: q.pageSize });
});

notificationRouter.get('/unread-count', async (req, res) => {
  res.json({ unread: await Notification.countDocuments({ user: req.auth!.user._id, readAt: null }) });
});

notificationRouter.post('/:id/read', async (req, res) => {
  objectId(req.params.id, 'Notification');
  // Scoped by user: marking someone else's notification is a silent no-op.
  await Notification.updateOne({ _id: req.params.id, user: req.auth!.user._id, readAt: null }, { $set: { readAt: new Date() } });
  res.json({ ok: true });
});

notificationRouter.post('/read-all', async (req, res) => {
  const r = await Notification.updateMany({ user: req.auth!.user._id, readAt: null }, { $set: { readAt: new Date() } });
  res.json({ ok: true, updated: r.modifiedCount });
});
