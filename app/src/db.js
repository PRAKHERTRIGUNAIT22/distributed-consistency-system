import pg from 'pg';
import { config } from './config.js';

// One connection pool per app instance.
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  connectionTimeoutMillis: 3000, // fail fast -> the API answers 503 instead of hanging
  idleTimeoutMillis: 30000,
});

// Without this handler, an error on an idle connection would crash the process.
pool.on('error', (err) => {
  console.error('Idle Postgres client error:', err.message);
});

/** Run a single statement (autocommit: it is committed as soon as it finishes). */
export function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run several statements as ONE transaction.
 * `fn` receives a client; call client.query(...) on it. Commits if fn resolves,
 * rolls back if it throws.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true; // connection is dead: don't put it back in the pool
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

export async function ping() {
  await pool.query('SELECT 1');
}

export function closePool() {
  return pool.end();
}