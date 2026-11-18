import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { corsOrigins } from '../config/env';
import { logger } from '../lib/logger';
import { toPlain } from '../lib/serialize';
import { type AuthUser, verifyAccessToken } from '../lib/tokens';
import { type RealtimeEvent, RealtimeEvents, Rooms } from './events';

let io: Server | null = null;

export function initRealtime(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: corsOrigins },
    pingInterval: 25_000,
    pingTimeout: 20_000,
    // Si el celular pierde señal unos segundos, al volver recibe lo que se perdió.
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000, skipMiddlewares: false },
  });

  // Autenticación en el handshake: el cliente envía { auth: { token: "<accessToken>" } }
  io.use((socket, next) => {
    const raw =
      (socket.handshake.auth?.token as string | undefined) ??
      socket.handshake.headers.authorization?.replace(/^Bearer /, '');
    if (!raw) return next(new Error('UNAUTHORIZED'));
    try {
      socket.data.user = verifyAccessToken(raw);
      next();
    } catch {
      next(new Error('TOKEN_EXPIRED_OR_INVALID'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user as AuthUser;
    void socket.join([Rooms.STAFF, Rooms.user(user.id)]);
    if (user.role === 'OWNER') void socket.join(Rooms.OWNERS);

    socket.emit(RealtimeEvents.SESSION_READY, {
      data: { userId: user.id, role: user.role, recovered: socket.recovered },
      emittedAt: new Date().toISOString(),
    });

    logger.debug({ userId: user.id, socketId: socket.id }, 'Socket conectado');
    socket.on('disconnect', (reason) => logger.debug({ userId: user.id, reason }, 'Socket desconectado'));
  });

  return io;
}

interface PublishOptions {
  room?: string;
  except?: string;
}

/**
 * Emite un evento a los dispositivos conectados. Se llama SIEMPRE después
 * de que la transacción en BD hizo commit, nunca dentro de ella.
 */
export function publish(event: RealtimeEvent, data: unknown, opts: PublishOptions = {}) {
  if (!io) return;
  const envelope = { data: toPlain(data), emittedAt: new Date().toISOString() };
  let target = io.to(opts.room ?? Rooms.STAFF);
  if (opts.except) target = target.except(opts.except);
  target.emit(event, envelope);
}

export async function closeRealtime() {
  if (io) await io.close();
  io = null;
}
