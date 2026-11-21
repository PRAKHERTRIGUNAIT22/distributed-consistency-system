import { config } from './config.js';
import { closePool, pool, ping } from './db.js';
import * as repo from './Repo.js';
import * as redis from './Redisguard.js';
import { closeRedis } from './Redisguard.js';
import * as bank from './Bank.js';
import { createPaymentService } from './paymentservice.js';
import { createApp } from './app.js';
import { startRecoveryJob } from './recovery.js';

const service = createPaymentService({ repo, redis, bank, config });
const app = createApp({ service, instanceId: config.instanceId, dbPing: ping });
const stopRecoveryJob = startRecoveryJob({ service, intervalMs: config.recoveryIntervalMs });

const server = app.listen(config.port, () => {
  console.log(`[${config.instanceId}] idempotent-gateway listening on :${config.port}`);
});

// Give in-flight requests a chance to finish, then release Postgres/Redis connections.
async function shutdown(signal) {
  console.log(`[${config.instanceId}] ${signal} received, shutting down`);
  stopRecoveryJob();
  server.close(async () => {
    await Promise.allSettled([closePool(), closeRedis()]);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref(); // force-exit if something hangs
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A pool-level error (e.g. Postgres restarting) must not crash the process.
pool.on('error', (err) => console.error('[db] pool error:', err.message));