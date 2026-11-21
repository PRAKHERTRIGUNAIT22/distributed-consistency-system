// All SQL lives here. PostgreSQL is the source of truth for every idempotency decision.
//
// Note: node-postgres returns NUMERIC columns as strings ("500.00"), not numbers.
// That is deliberate (no floating-point errors on money); the service compares amounts in cents.

import { query, withTransaction } from './db.js';

/** Thrown when another worker already completed this key (the loser of a race). */
export class AlreadyFinalizedError extends Error {
  constructor() {
    super('Idempotency key already finalized');
    this.name = 'AlreadyFinalizedError';
  }
}

const toSession = (r) => ({
  id: r.id,
  amount: r.amount,
  currency: r.currency,
  status: r.status,
  expiresAt: r.expires_at,
});

// ---- sessions ---------------------------------------------------------

export async function createSession(amount, currency) {
  const { rows } = await query(
    `INSERT INTO payment_sessions (amount, currency) VALUES ($1, $2)
     RETURNING id, amount, currency, status, expires_at`,
    [amount, currency],
  );
  return toSession(rows[0]);
}

export async function findSession(id) {
  const { rows } = await query(
    `SELECT id, amount, currency, status, expires_at
       FROM payment_sessions WHERE id = $1`,
    [id],
  );
  return rows[0] ? toSession(rows[0]) : null;
}

/** Expire sessions nobody started paying for. Sessions that have a key are left for recovery. */
export async function expireSessions() {
  const { rowCount } = await query(
    `UPDATE payment_sessions s SET status = 'EXPIRED'
      WHERE s.status = 'CREATED' AND s.expires_at < now()
        AND NOT EXISTS (SELECT 1 FROM idempotency_keys k WHERE k.idempotency_key = s.id)`,
  );
  return rowCount;
}

// ---- idempotency keys -------------------------------------------------

/**
 * The core race-safe primitive. Runs as its own autocommit statement, so the STARTED row
 * is visible to every other instance immediately. Of any number of concurrent callers,
 * exactly one gets `true`.
 */
export async function claimKey(key, requestHash) {
  const { rowCount } = await query(
    `INSERT INTO idempotency_keys (idempotency_key, request_hash)
     VALUES ($1, $2)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [key, requestHash],
  );
  return rowCount === 1;
}

export async function findKey(key) {
  const { rows } = await query(
    `SELECT request_hash, status, response_status, response_body
       FROM idempotency_keys WHERE idempotency_key = $1`,
    [key],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    requestHash: r.request_hash,
    status: r.status,
    responseStatus: r.response_status,
    responseBody: r.response_body, // JSONB comes back already parsed into an object
  };
}

/**
 * ONE transaction: complete the key + record the payment (+ mark the session paid).
 *
 * The UPDATE goes first on purpose: it row-locks the key. A racing finalizer (for example the
 * recovery job) waits, then sees status <> 'STARTED', updates 0 rows, and loses cleanly.
 * UNIQUE (idempotency_key) on payments is the last safety net (error code 23505).
 */
export async function finalizePayment({
  key,
  paymentId,
  amount,
  currency,
  approved,
  bankReference,
  responseStatus,
  responseBody,
}) {
  try {
    await withTransaction(async (tx) => {
      const updated = await tx.query(
        `UPDATE idempotency_keys
            SET status = 'COMPLETED', response_status = $1, response_body = $2::jsonb,
                completed_at = now()
          WHERE idempotency_key = $3 AND status = 'STARTED'`,
        [responseStatus, JSON.stringify(responseBody), key],
      );
      if (updated.rowCount === 0) throw new AlreadyFinalizedError();

      await tx.query(
        `INSERT INTO payments (id, idempotency_key, amount, currency, status, bank_reference)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [paymentId, key, amount, currency, approved ? 'SUCCESS' : 'FAILED', bankReference],
      );

      if (approved) {
        await tx.query(`UPDATE payment_sessions SET status = 'PAID' WHERE id = $1`, [key]);
      }
    });
  } catch (err) {
    if (err.code === '23505') throw new AlreadyFinalizedError(); // unique violation
    throw err;
  }
}

// ---- recovery ---------------------------------------------------------

/** Keys stuck in STARTED for longer than `olderThanSeconds` (an instance crashed mid-request). */
export async function findStuckKeys(olderThanSeconds) {
  const { rows } = await query(
    `SELECT idempotency_key FROM idempotency_keys
      WHERE status = 'STARTED' AND locked_at < now() - ($1::int * INTERVAL '1 second')
      ORDER BY locked_at LIMIT 50`,
    [olderThanSeconds],
  );
  return rows.map((r) => r.idempotency_key);
}

/**
 * Compare-and-set lease: the UPDATE only matches for one caller, so only one instance
 * gets `true` and re-drives the key.
 */
export async function reclaimStuckKey(key, olderThanSeconds) {
  const { rowCount } = await query(
    `UPDATE idempotency_keys SET locked_at = now()
      WHERE idempotency_key = $1 AND status = 'STARTED'
        AND locked_at < now() - ($2::int * INTERVAL '1 second')`,
    [key, olderThanSeconds],
  );
  return rowCount === 1;
}