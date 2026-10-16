import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose, { type ClientSession } from 'mongoose';
import { config } from './config.js';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);

let memoryServer: { stop: () => Promise<unknown> } | null = null;

/**
 * Connects to MongoDB. MONGODB_URI=memory starts a local single-node replica set
 * (development only) persisting under server/.data so transactions work without
 * installing MongoDB or Docker.
 */
export async function connectDatabase(uri = config.MONGODB_URI) {
  let target = uri;
  if (uri === 'memory') {
    if (config.isProd) throw new Error('In-memory MongoDB is not allowed in production');
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dbPath = path.resolve(here, '..', '.data');
    const fs = await import('node:fs');
    fs.mkdirSync(dbPath, { recursive: true });
    const rs = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger', name: 'rs0' },
      instanceOpts: [{ dbPath, port: 27027 }],
    });
    memoryServer = rs;
    target = rs.getUri('cab_booking');
    logger.warn({ dbPath }, 'Using local development MongoDB replica set (MONGODB_URI=memory)');
  }
  await mongoose.connect(target, { serverSelectionTimeoutMS: 15000 });
  logger.info('MongoDB connected');
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
  if (memoryServer) await memoryServer.stop();
}

export type TxContext = {
  session: ClientSession;
  /** Register a side effect (socket emit, metric) that must only run after commit. */
  afterCommit: (fn: () => void | Promise<void>) => void;
};

/**
 * Runs fn inside a MongoDB transaction with automatic retry on transient errors
 * (e.g. WriteConflict from concurrent assignments). Side effects registered via
 * afterCommit run once, only after a successful commit.
 */
export async function withTransaction<T>(fn: (tx: TxContext) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  let callbacks: Array<() => void | Promise<void>> = [];
  try {
    let result!: T;
    await session.withTransaction(
      async () => {
        callbacks = [];
        result = await fn({ session, afterCommit: (cb) => callbacks.push(cb) });
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' },
    );
    for (const cb of callbacks) {
      try {
        await cb();
      } catch (err) {
        logger.error({ err }, 'afterCommit callback failed');
      }
    }
    return result;
  } finally {
    await session.endSession();
  }
}

export function isDuplicateKeyError(err: unknown): err is { code: number; keyPattern?: Record<string, unknown> } {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}
