import Redis from 'ioredis';
import { config } from './config.js';

// Redis is a SPEED layer only: an in-flight lock and a cache of finished responses.
// Every function here FAILS OPEN: if Redis is down we skip it, and PostgreSQL still
// guarantees correctness. Redis can never be the reason a payment is charged twice,
// or wrongly rejected.

export const LockResult = Object.freeze({
  ACQUIRED: 'ACQUIRED',
  BUSY: 'BUSY',
  UNAVAILABLE: 'UNAVAILABLE',
});

const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  connectTimeout: 500,
  commandTimeout: 500, // a slow Redis must not slow payments down
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false, // while disconnected, fail immediately instead of queueing commands
  retryStrategy: (attempt) => Math.min(attempt * 200, 2000), // keep reconnecting in the background
});

// Log state changes once, not on every failed command.
let down = false;
redis.on('error', (err) => {
  if (!down) {
    down = true;
    console.warn(`[redis] unavailable (${err.message}); failing open, Postgres decides`);
  }
});
redis.on('ready', () => {
  if (down) console.info('[redis] connection restored');
  down = false;
});

// A busy outage would otherwise print a warning per request.
let lastWarn = 0;
function warn(message) {
  const now = Date.now();
  if (now - lastWarn > 10_000) {
    lastWarn = now;
    console.warn(`[redis] ${message}`);
  }
}

const lockKey = (key) => `idem:lock:${key}`;
const respKey = (key) => `idem:resp:${key}`;

// Compare-and-delete: only the lock's owner may release it. Without the token check, a slow
// request whose lock already expired could delete the lock of a newer request.
const RELEASE_SCRIPT = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  else
    return 0
  end`;

/** SET key token EX ttl NX  ->  ACQUIRED, BUSY (someone else holds it) or UNAVAILABLE. */
export async function tryLock(key, token, ttlSeconds) {
  try {
    const reply = await redis.set(lockKey(key), token, 'EX', ttlSeconds, 'NX');
    return reply === 'OK' ? LockResult.ACQUIRED : LockResult.BUSY;
  } catch (err) {
    warn(`lock failed for ${key}: ${err.message}`);
    return LockResult.UNAVAILABLE;
  }
}

export async function unlock(key, token) {
  try {
    await redis.eval(RELEASE_SCRIPT, 1, lockKey(key), token);
  } catch (err) {
    warn(`unlock failed for ${key}: ${err.message} (the lock will expire by TTL)`);
  }
}

/** Cached completed response: { requestHash, status, body } or null. */
export async function getCached(key) {
  try {
    const json = await redis.get(respKey(key));
    return json ? JSON.parse(json) : null;
  } catch (err) {
    warn(`cache read failed for ${key}: ${err.message}`);
    return null;
  }
}

export async function cache(key, result, ttlSeconds) {
  try {
    await redis.set(respKey(key), JSON.stringify(result), 'EX', ttlSeconds);
  } catch (err) {
    warn(`cache write failed for ${key}: ${err.message}`);
  }
}

export async function closeRedis() {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}