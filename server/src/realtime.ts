import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { parse as parseCookie } from './utils/cookies.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { resolveSession, SESSION_COOKIE } from './services/session.service.js';
import { Driver } from './models/Driver.js';
import { Coordinator } from './models/Coordinator.js';

let io: Server | null = null;

/**
 * Real-time channel. Sockets authenticate with the same httpOnly session cookie
 * as the REST API and join rooms for their user id, role and (coordinators) offices.
 * Notifications are always persisted first; the socket push is best-effort and
 * clients re-sync unread notifications from the API on (re)connect.
 */
export function initRealtime(server: HttpServer) {
  io = new Server(server, {
    path: '/socket.io',
    cors: config.isProd ? undefined : { origin: config.APP_BASE_URL, credentials: true },
    serveClient: false,
  });

  io.use(async (socket, next) => {
    try {
      const cookies = parseCookie(socket.handshake.headers.cookie ?? '');
      const token = cookies[SESSION_COOKIE];
      const auth = token ? await resolveSession(token, { touch: false }) : null;
      if (!auth) return next(new Error('UNAUTHORIZED'));
      socket.data.user = { id: String(auth.user._id), role: auth.user.role, sessionId: String(auth.session._id) };
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  io.on('connection', async (socket: Socket) => {
    const { id, role } = socket.data.user as { id: string; role: string };
    await socket.join([`user:${id}`, `role:${role}`]);
    if (role === 'COORDINATOR') {
      const coord = await Coordinator.findOne({ user: id }).lean();
      for (const office of coord?.officeLocations ?? []) await socket.join(`office:${office}`);
    }
    if (role === 'DRIVER') {
      await Driver.updateOne({ user: id }, { $set: { lastSeenAt: new Date() } });
    }
    socket.emit('ready', { ok: true });
    socket.on('disconnect', async () => {
      if (role === 'DRIVER') await Driver.updateOne({ user: id }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
    });
  });

  logger.info('Realtime channel initialised');
  return io;
}

export function emitToUser(userId: string, event: string, payload: unknown) {
  io?.to(`user:${userId}`).emit(event, payload);
}

export function emitToRole(role: string, event: string, payload: unknown) {
  io?.to(`role:${role}`).emit(event, payload);
}

/** Coordinators scoped to an office + all admins. */
export function emitToOperations(officeLocation: string | undefined, event: string, payload: unknown) {
  if (!io) return;
  const rooms = ['role:ADMIN'];
  if (officeLocation) rooms.push(`office:${officeLocation}`);
  io.to(rooms).emit(event, payload);
}

export async function disconnectUserSockets(userId: string) {
  if (!io) return;
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const s of sockets) s.disconnect(true);
}

export function closeRealtime() {
  io?.close();
  io = null;
}
