import { AsyncLocalStorage } from 'node:async_hooks';
import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { parse as parseCookie } from './utils/cookies.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { resolveSession, SESSION_COOKIE } from './services/session.service.js';
import { Driver } from './models/Driver.js';
import { Coordinator } from './models/Coordinator.js';
import { Employee } from './models/Employee.js';

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

/**
 * Who a change concerns: the people whose rides it touches, and the offices whose transport team
 * should see it. Collected while a request runs and announced once, after it has succeeded.
 */
type ChangeScope = { users: Set<string>; offices: Set<string>; everyone: boolean };
const changeScope = new AsyncLocalStorage<ChangeScope>();

/** Runs a request with its own change scope; `announce` tells everyone concerned once it has succeeded. */
export function trackChanges(next: () => void) {
  const scope: ChangeScope = { users: new Set(), offices: new Set(), everyone: false };
  changeScope.run(scope, next);
  return (actor?: { id: string; role: string }) => announceChange(scope, actor).catch((err) => logger.warn({ err }, 'Live update failed'));
}

/**
 * Notes who a change concerns. Inside a request it is announced when the request succeeds; from
 * background work (auto-cancel, late pickups) at once.
 */
export function noteChange(c: { users?: unknown[]; offices?: Array<string | null | undefined>; everyone?: boolean }) {
  const scope = changeScope.getStore();
  const target = scope ?? { users: new Set<string>(), offices: new Set<string>(), everyone: false };
  for (const u of c.users ?? []) if (u) target.users.add(String(u));
  for (const o of c.offices ?? []) if (o) target.offices.add(o);
  if (c.everyone) target.everyone = true;
  if (!scope) emitDataChanged(target);
}

/**
 * "Something changed" to the screens it concerns: the people whose rides changed, the transport
 * team of those offices, and admins (who see everything). It carries no data: each screen
 * re-fetches through its own API, which only returns what that person may see.
 */
function emitDataChanged(scope: ChangeScope) {
  if (!io) return;
  if (scope.everyone) {
    io.emit('data:changed');
    return;
  }
  const rooms = ['role:ADMIN', ...[...scope.users].map((u) => `user:${u}`), ...[...scope.offices].map((o) => `office:${o}`)];
  io.to(rooms).emit('data:changed');
}

/** A successful request: tells whoever it concerns. When nothing more specific is known, the actor's offices. */
async function announceChange(scope: ChangeScope, actor?: { id: string; role: string }) {
  if (!io) return;
  if (actor?.id) scope.users.add(actor.id);
  if (!scope.offices.size && !scope.everyone && actor?.id) {
    if (actor.role === 'COORDINATOR') {
      for (const o of (await Coordinator.findOne({ user: actor.id }, { officeLocations: 1 }).lean())?.officeLocations ?? []) scope.offices.add(o);
    } else if (actor.role === 'EMPLOYEE') {
      const office = (await Employee.findOne({ user: actor.id }, { officeLocation: 1 }).lean())?.officeLocation;
      if (office) scope.offices.add(office);
    } else if (actor.role === 'DRIVER') {
      const office = (await Driver.findOne({ user: actor.id }, { officeLocation: 1 }).lean())?.officeLocation;
      if (office) scope.offices.add(office);
    } else if (actor.role === 'ADMIN') {
      // Admin changes (people, cabs, settings) concern every transport team.
      io.to(['role:ADMIN', 'role:COORDINATOR', ...[...scope.users].map((u) => `user:${u}`)]).emit('data:changed');
      return;
    }
  }
  emitDataChanged(scope);
}

/** Coordinators scoped to an office + all admins. */
export function emitToOperations(officeLocation: string | undefined, event: string, payload: unknown) {
  noteChange({ offices: [officeLocation] });
  if (!io) return;
  const rooms = ['role:ADMIN'];
  if (officeLocation) rooms.push(`office:${officeLocation}`);
  io.to(rooms).emit(event, payload);
}

/** Closes the user's live connections (all, or all but one session's). */
export async function disconnectUserSockets(userId: string, exceptSessionId?: string) {
  if (!io) return;
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const s of sockets) if (!exceptSessionId || (s.data.user as { sessionId?: string } | undefined)?.sessionId !== exceptSessionId) s.disconnect(true);
}

export function closeRealtime() {
  io?.close();
  io = null;
}
