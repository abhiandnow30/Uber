import { connectDatabase, disconnectDatabase } from '../db.js';
import { getPolicy } from '../services/policy.service.js';
import { syncIndexes } from './indexes.js';

/** Run before deploying a new version: ensures collections, indexes and the default policy exist. */
await connectDatabase();
await syncIndexes();
await getPolicy();
console.log('Migration complete');
await disconnectDatabase();
