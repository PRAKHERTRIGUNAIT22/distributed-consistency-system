// The core of the project: idempotent payment processing.
//
// Request flow for POST /pay/:sessionId   (the session id IS the idempotency key)
//
//   1. completed already?   -> replay the stored response (422 if the request body differs)
//   2. validate the session -> 404 / 410 / 422
//   3. Redis lock (NX)      -> 409 if another request holds it; skipped if Redis is down
//   4. DB claim             -> INSERT .. ON CONFLICT DO NOTHING: exactly one winner
//   5. call the bank        -> outside any DB transaction; the bank is idempotent by reference
//   6. ONE transaction      -> complete the key + insert the payment (+ mark session PAID)
//   7. cache in Redis, release the lock
//
// The dependencies (repo, redis, bank, config) are passed in. server.js hands over the real
// ones; the tests hand over in-memory fakes.

import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from './error.js';
import { toCents } from './money.js';

/** An original 201 is replayed as 200, so "exactly one 201" is easy to assert. */
const replayStatus = (original) => (original === 201 ? 200 : original);

const inFlight = () =>
  new ApiError(409, 'REQUEST_IN_FLIGHT', 'A request for this session is already being processed. Retry shortly.');

const keyReused = () =>
  new ApiError(422, 'KEY_REUSED', 'This session was already used with a different request body');

/** SHA-256 fingerprint of the request body, to detect the same key reused with a different body. */
function requestHash({ amount, currency, payerRef }) {
  const canonical = `${toCents(amount)}|${currency}|${payerRef}`;
  return createHash('sha256').update(canonical).digest('hex'); // 64 hex chars -> CHAR(64)
}

export function createPaymentService({ repo, redis, bank, config }) {
  const { LockResult } = redis;
  const keyTtlSeconds = config.keyTtlHours * 3600;

  // ---------------------------------------------------------------- sessions

  async function createSession(amount, currency = 'INR') {
    return repo.createSession(amount, currency);
  }

  // --------------------------------------------------------------------- pay

  async function pay(sessionId, req) {
    const hash = requestHash(req);

    const session = await repo.findSession(sessionId);
    if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Unknown payment session');

    // 1. Fast path: already completed -> replay
    const done = await findCompleted(sessionId);
    if (done) return replayOrReject(done, hash);

    // 2. Validate the request against the session
    if (new Date(session.expiresAt) < new Date()) {
      throw new ApiError(410, 'SESSION_EXPIRED', 'This payment session has expired');
    }
    if (toCents(req.amount) !== toCents(session.amount) || req.currency !== session.currency) {
      throw new ApiError(422, 'SESSION_MISMATCH', 'Amount or currency does not match the session');
    }

    // 3. Redis in-flight lock (an optimisation; the database is still the arbiter)
    const token = randomUUID();
    const lock = await redis.tryLock(sessionId, token, config.lockTtlSeconds);
    if (lock === LockResult.BUSY) throw inFlight();

    try {
      return await claimAndProcess(sessionId, session, hash);
    } finally {
      if (lock === LockResult.ACQUIRED) await redis.unlock(sessionId, token);
    }
  }

  async function claimAndProcess(sessionId, session, hash) {
    // 4. Race-safe claim: of any number of concurrent callers, exactly one gets `true`
    if (!(await repo.claimKey(sessionId, hash))) {
      const row = await repo.findKey(sessionId);
      if (!row) throw inFlight();
      if (row.requestHash !== hash) throw keyReused();
      if (row.status === 'COMPLETED') {
        return { status: replayStatus(row.responseStatus), body: row.responseBody, replayed: true };
      }
      throw inFlight(); // STARTED: the owner is still working (or crashed; recovery will handle it)
    }

    // We own this payment. 5. Call the bank OUTSIDE any DB transaction.
    let result;
    try {
      result = await bank.charge(sessionId, toCents(session.amount));
    } catch (err) {
      // The key stays STARTED. The recovery job re-drives it using the same bank reference.
      console.error(`[pay] bank call failed for ${sessionId}: ${err.message}`);
      throw new ApiError(502, 'BANK_ERROR', 'Bank call failed; the payment will be re-checked automatically. Retry shortly.');
    }
    return finish(sessionId, session, result, hash);
  }

  /** Steps 6 + 7: persist atomically, then cache. Also used by the recovery job. */
  async function finish(key, session, result, hash) {
    const paymentId = randomUUID();
    const approved = result.approved;
    const status = approved ? 201 : 402;
    const body = {
      paymentId,
      sessionId: key,
      status: approved ? 'SUCCESS' : 'FAILED',
      amount: session.amount,
      currency: session.currency,
      ...(result.bankReference && { bankReference: result.bankReference }),
      ...(result.declineReason && { declineReason: result.declineReason }),
    };

    try {
      await repo.finalizePayment({
        key,
        paymentId,
        amount: session.amount,
        currency: session.currency,
        approved,
        bankReference: result.bankReference,
        responseStatus: status,
        responseBody: body,
      });
    } catch (err) {
      if (!(err instanceof repo.AlreadyFinalizedError)) throw err;
      // Another worker (e.g. the recovery job) finished first: replay its result.
      const row = await repo.findKey(key);
      if (!row || row.status !== 'COMPLETED') throw inFlight();
      return { status: replayStatus(row.responseStatus), body: row.responseBody, replayed: true };
    }

    await redis.cache(key, { requestHash: hash, status, body }, keyTtlSeconds);
    return { status, body, replayed: false };
  }

  // ---------------------------------------------------------------- recovery

  /**
   * Re-drive a payment stuck in STARTED (an instance crashed mid-request). Safe because
   * (a) the lease in reclaimStuckKey lets only one instance proceed,
   * (b) the bank dedupes by reference, and
   * (c) finalizePayment can only succeed once.
   */
  async function recover(key) {
    if (!(await repo.reclaimStuckKey(key, config.stuckAfterSeconds))) return false;

    const session = await repo.findSession(key);
    const row = await repo.findKey(key);
    if (!session || !row) return false;

    console.warn(`[recovery] re-driving stuck payment ${key}`);
    const result = await bank.charge(key, toCents(session.amount));
    await finish(key, session, result, row.requestHash);
    return true;
  }

  // ----------------------------------------------------------------- helpers

  /** Completed response for this key: Redis cache first, then Postgres. */
  async function findCompleted(key) {
    const cached = await redis.getCached(key);
    if (cached) return cached;

    const row = await repo.findKey(key);
    if (!row || row.status !== 'COMPLETED') return null;

    const stored = { requestHash: row.requestHash, status: row.responseStatus, body: row.responseBody };
    await redis.cache(key, stored, keyTtlSeconds);
    return stored;
  }

  function replayOrReject(stored, hash) {
    if (stored.requestHash !== hash) throw keyReused();
    return { status: replayStatus(stored.status), body: stored.body, replayed: true };
  }

  return {
    createSession,
    pay,
    recover,
    findStuckKeys: () => repo.findStuckKeys(config.stuckAfterSeconds),
    expireSessions: () => repo.expireSessions(),
  };
}