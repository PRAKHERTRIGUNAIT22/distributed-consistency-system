// Tests the payment logic with in-memory fakes (no Postgres, Redis or network needed).
// Run with:  npm test
//
// The fakes yield to the event loop on every call, so concurrent requests really do interleave.
// The fake claimKey is check-and-set with no gap, which is what Postgres guarantees for
// INSERT ... ON CONFLICT DO NOTHING. These tests prove the SERVICE LOGIC is right; the SQL
// itself is proven by the load test against real Postgres.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPaymentService } from '../src/paymentService.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeFakeRepo() {
  class AlreadyFinalizedError extends Error {}
  const sessions = new Map();
  const keys = new Map();
  const payments = [];
  return {
    AlreadyFinalizedError, sessions, keys, payments,
    async createSession(amount, currency) {
      const s = { id: randomUUID(), amount, currency, status: 'CREATED', expiresAt: new Date(Date.now() + 60_000) };
      sessions.set(s.id, s);
      return s;
    },
    async findSession(id) { await tick(); return sessions.get(id) ?? null; },
    async claimKey(key, hash) {
      await tick();
      if (keys.has(key)) return false; // check and set with no gap = atomic
      keys.set(key, { requestHash: hash, status: 'STARTED', responseStatus: null, responseBody: null, lockedAt: Date.now() });
      return true;
    },
    async findKey(key) { await tick(); const k = keys.get(key); return k ? { ...k } : null; },
    async finalizePayment({ key, paymentId, amount, currency, approved, bankReference, responseStatus, responseBody }) {
      await tick();
      const k = keys.get(key);
      if (!k || k.status !== 'STARTED') throw new AlreadyFinalizedError();
      k.status = 'COMPLETED'; k.responseStatus = responseStatus; k.responseBody = responseBody;
      payments.push({ key, paymentId, amount, currency, approved, bankReference });
    },
    async findStuckKeys(sec) {
      return [...keys].filter(([, k]) => k.status === 'STARTED' && Date.now() - k.lockedAt >= sec * 1000).map(([id]) => id);
    },
    async reclaimStuckKey(key, sec) {
      const k = keys.get(key);
      if (k && k.status === 'STARTED' && Date.now() - k.lockedAt >= sec * 1000) { k.lockedAt = Date.now(); return true; }
      return false;
    },
    async expireSessions() { return 0; },
  };
}

function makeFakeRedis({ down = false } = {}) {
  const locks = new Map();
  const store = new Map();
  return {
    LockResult: { ACQUIRED: 'ACQUIRED', BUSY: 'BUSY', UNAVAILABLE: 'UNAVAILABLE' },
    async tryLock(key, token) {
      await tick();
      if (down) return 'UNAVAILABLE';
      if (locks.has(key)) return 'BUSY';
      locks.set(key, token);
      return 'ACQUIRED';
    },
    async unlock(key, token) { if (locks.get(key) === token) locks.delete(key); },
    async getCached(key) { await tick(); return down ? null : (store.get(key) ?? null); },
    async cache(key, value) { if (!down) store.set(key, value); },
  };
}

function makeFakeBank() {
  return {
    calls: 0,
    failNext: false,
    async charge(reference, amountCents) {
      this.calls += 1;
      await sleep(20);
      if (this.failNext) { this.failNext = false; throw new Error('bank timeout'); }
      if (amountCents > 100000 * 100) return { approved: false, bankReference: null, declineReason: 'AMOUNT_LIMIT_EXCEEDED' };
      return { approved: true, bankReference: `BANK-${reference.slice(0, 8)}`, declineReason: null };
    },
  };
}

async function setup({ redisDown = false, stuckAfterSeconds = 120 } = {}) {
  const repo = makeFakeRepo();
  const redis = makeFakeRedis({ down: redisDown });
  const bank = makeFakeBank();
  const service = createPaymentService({
    repo, redis, bank,
    config: { lockTtlSeconds: 30, keyTtlHours: 24, stuckAfterSeconds },
  });
  const session = await service.createSession('500.00', 'INR');
  const body = { amount: 500, currency: 'INR', payerRef: 'user-42' };
  return { repo, redis, bank, service, session, body };
}

const errorCode = (promise) => promise.then(() => null, (e) => `${e.status} ${e.code}`);

test('first request succeeds with 201, a retry replays it as 200 without charging again', async () => {
  const { service, session, body, bank, repo } = await setup();
  const first = await service.pay(session.id, body);
  assert.equal(first.status, 201);
  assert.equal(first.replayed, false);

  const retry = await service.pay(session.id, body);
  assert.equal(retry.status, 200);
  assert.equal(retry.replayed, true);
  assert.equal(retry.body.paymentId, first.body.paymentId);
  assert.equal(bank.calls, 1);
  assert.equal(repo.payments.length, 1);
});

test('same session with a different body is rejected with 422', async () => {
  const { service, session, body } = await setup();
  await service.pay(session.id, body);
  assert.equal(await errorCode(service.pay(session.id, { ...body, payerRef: 'someone-else' })), '422 KEY_REUSED');
});

test('amount that does not match the session is rejected with 422', async () => {
  const { service, session, body, bank } = await setup();
  assert.equal(await errorCode(service.pay(session.id, { ...body, amount: 900 })), '422 SESSION_MISMATCH');
  assert.equal(bank.calls, 0);
});

test('unknown session gives 404, expired session gives 410', async () => {
  const { service, repo, session, body } = await setup();
  assert.equal(await errorCode(service.pay(randomUUID(), body)), '404 SESSION_NOT_FOUND');
  repo.sessions.get(session.id).expiresAt = new Date(Date.now() - 1000);
  assert.equal(await errorCode(service.pay(session.id, body)), '410 SESSION_EXPIRED');
});

test('a declined payment returns 402 and replays the same 402', async () => {
  const { service, repo } = await setup();
  const big = await service.createSession('200000.00', 'INR');
  const body = { amount: 200000, currency: 'INR', payerRef: 'user-42' };
  const first = await service.pay(big.id, body);
  assert.equal(first.status, 402);
  const retry = await service.pay(big.id, body);
  assert.equal(retry.status, 402);
  assert.equal(retry.replayed, true);
  assert.equal(repo.payments.length, 1);
});

async function hundredConcurrent(options) {
  const { service, session, body, bank, repo } = await setup(options);
  const results = await Promise.allSettled(Array.from({ length: 100 }, () => service.pay(session.id, body)));

  const created = results.filter((r) => r.status === 'fulfilled' && r.value.status === 201);
  const replays = results.filter((r) => r.status === 'fulfilled' && r.value.status === 200);
  const inFlightRejections = results.filter((r) => r.status === 'rejected' && r.reason.status === 409);

  assert.equal(created.length, 1, 'exactly one request creates the payment');
  assert.equal(created.length + replays.length + inFlightRejections.length, 100, 'every other request is a 200 replay or a 409');
  assert.equal(repo.payments.length, 1, 'exactly one payment row');
  assert.equal(bank.calls, 1, 'the bank is charged exactly once');
}

test('100 concurrent identical requests produce exactly one payment', () => hundredConcurrent());

test('100 concurrent identical requests still produce exactly one payment when Redis is down', () =>
  hundredConcurrent({ redisDown: true }));

test('bank failure leaves the key STARTED; the recovery job finishes it; a retry then replays', async () => {
  const { service, session, body, bank, repo } = await setup({ stuckAfterSeconds: 0 });
  bank.failNext = true;
  assert.equal(await errorCode(service.pay(session.id, body)), '502 BANK_ERROR');
  assert.equal(repo.keys.get(session.id).status, 'STARTED');
  assert.equal(repo.payments.length, 0);

  // a retry while the key is stuck must not charge again
  assert.equal(await errorCode(service.pay(session.id, body)), '409 REQUEST_IN_FLIGHT');

  for (const key of await service.findStuckKeys()) await service.recover(key);
  assert.equal(repo.keys.get(session.id).status, 'COMPLETED');
  assert.equal(repo.payments.length, 1);

  const retry = await service.pay(session.id, body);
  assert.equal(retry.status, 200);
  assert.equal(retry.replayed, true);
  assert.equal(repo.payments.length, 1);
});