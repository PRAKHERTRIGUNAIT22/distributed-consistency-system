// All settings come from environment variables (set in docker-compose.yml).
// The defaults point at localhost, so `npm run dev` works against
// `docker compose up postgres redis -d` with no extra setup.

function int(name, fallback) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  }
  return value;
}

export const config = Object.freeze({
  port: int('PORT', 8080),
  instanceId: process.env.INSTANCE_ID ?? 'local',

  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://gateway:gateway_pw@localhost:5432/gateway',
  dbPoolMax: int('DB_POOL_MAX', 20), // 3 instances x 20 = 60, under Postgres max_connections=200

  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: int('REDIS_PORT', 6379),
  },

  lockTtlSeconds: int('LOCK_TTL_SECONDS', 30),
  keyTtlHours: int('KEY_TTL_HOURS', 24),
  stuckAfterSeconds: int('STUCK_AFTER_SECONDS', 120), // STARTED keys older than this get re-driven
  recoveryIntervalMs: int('RECOVERY_INTERVAL_MS', 30000),

  bank: {
    latencyMs: int('BANK_LATENCY_MS', 200), // raise this to make concurrency/crash tests easier
    declineOver: int('BANK_DECLINE_OVER', 100000),
  },
});