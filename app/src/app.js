// Builds the Express app. Kept separate from server.js so tests can import it
// with supertest without opening a real network port.

import express from 'express';
import { ApiError } from './error.js';
import { createSessionSchema, paySchema, validateBody, validateUuidParam } from './validation.js';

export function createApp({ service, instanceId, dbPing }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  // Liveness/readiness: used by `depends_on: condition: service_healthy`-style checks
  // and handy for confirming which instance answered during the load test.
  app.get('/health', async (req, res) => {
    try {
      await dbPing();
      res.json({ status: 'ok', instance: instanceId });
    } catch {
      res.status(503).json({ status: 'db_unreachable', instance: instanceId });
    }
  });

  // Step 1: server generates the session (and its unique, single-use pay URL).
  app.post('/payment-sessions', validateBody(createSessionSchema), async (req, res, next) => {
    try {
      const { amount, currency } = req.body;
      const session = await service.createSession(amount, currency ?? 'INR');
      res.status(201).json({
        sessionId: session.id,
        payUrl: `/pay/${session.id}`,
        amount: session.amount,
        currency: session.currency,
        expiresAt: session.expiresAt,
      });
    } catch (err) {
      next(err);
    }
  });

  // Step 2: pay. The session id in the URL is the idempotency key. Safe to retry.
  app.post('/pay/:sessionId', validateUuidParam('sessionId'), validateBody(paySchema), async (req, res, next) => {
    try {
      const outcome = await service.pay(req.params.sessionId, req.body);
      res
        .status(outcome.status)
        .set('Idempotent-Replayed', String(outcome.replayed))
        .set('X-Served-By', instanceId) // shows the load balancer spreading requests across instances
        .json(outcome.body);
    } catch (err) {
      next(err);
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'No such route' });
  });

  // Central error handler. CP behaviour: a DB outage fails closed with 503, never a guess.
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.name === 'AggregateError') {
      console.error('Payment store unreachable:', err.message);
      return res.status(503).json({
        error: 'STORE_UNAVAILABLE',
        message: 'Payment store unavailable. Retry with the same session URL; retries are safe.',
      });
    }
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Unexpected error' });
  });

  return app;
}