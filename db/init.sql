-- =====================================================================
-- Idempotent Payment Gateway : schema
-- PostgreSQL 16. gen_random_uuid() is built in (PG 13+).
-- PostgreSQL is the source of truth; Redis is only a lock/cache layer.
-- =====================================================================

-- 1. Payment sessions -------------------------------------------------
-- Created by POST /payment-sessions. The session id doubles as the
-- idempotency key and appears in the auto-generated URL: /pay/{id}
CREATE TABLE payment_sessions (
    id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    currency    CHAR(3)       NOT NULL DEFAULT 'INR',
    status      VARCHAR(16)   NOT NULL DEFAULT 'CREATED'
                CHECK (status IN ('CREATED', 'PAID', 'EXPIRED')),
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ   NOT NULL DEFAULT now() + INTERVAL '30 minutes'
);

CREATE INDEX idx_sessions_expires ON payment_sessions (expires_at)
    WHERE status = 'CREATED';

-- 2. Idempotency keys -------------------------------------------------
-- One row per key. The PRIMARY KEY is what makes concurrent requests safe:
--   INSERT ... ON CONFLICT DO NOTHING  -> only one request "owns" the key.
CREATE TABLE idempotency_keys (
    idempotency_key  UUID         PRIMARY KEY
                     REFERENCES payment_sessions (id),
    request_hash     CHAR(64)     NOT NULL,          -- SHA-256 of request body
    status           VARCHAR(16)  NOT NULL DEFAULT 'STARTED'
                     CHECK (status IN ('STARTED', 'COMPLETED', 'FAILED')),
    response_status  INT,                            -- HTTP status to replay
    response_body    JSONB,                          -- body to replay
    locked_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    completed_at     TIMESTAMPTZ,
    expires_at       TIMESTAMPTZ  NOT NULL DEFAULT now() + INTERVAL '24 hours',

    -- a finished key must carry the response we will replay
    CONSTRAINT chk_completed_has_response CHECK (
        status = 'STARTED'
        OR (response_status IS NOT NULL AND response_body IS NOT NULL)
    )
);

-- recovery job: find keys stuck in STARTED after a crash
CREATE INDEX idx_idem_stuck ON idempotency_keys (locked_at)
    WHERE status = 'STARTED';

-- cleanup job: purge expired keys
CREATE INDEX idx_idem_expires ON idempotency_keys (expires_at);

-- 3. Payments ---------------------------------------------------------
-- UNIQUE (idempotency_key) is the final safety net: even if the Redis
-- layer or application logic has a bug, a second payment row for the
-- same key is physically impossible.
CREATE TABLE payments (
    id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key  UUID          NOT NULL UNIQUE
                     REFERENCES idempotency_keys (idempotency_key),
    amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    currency         CHAR(3)       NOT NULL,
    status           VARCHAR(16)   NOT NULL
                     CHECK (status IN ('SUCCESS', 'FAILED')),
    bank_reference   VARCHAR(64),                    -- id from the mock bank
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_created ON payments (created_at);

-- =====================================================================
-- Handy queries
-- =====================================================================

-- Core request logic (run inside one transaction):
--
--   INSERT INTO idempotency_keys (idempotency_key, request_hash)
--   VALUES (:key, :hash)
--   ON CONFLICT (idempotency_key) DO NOTHING;
--   -- 1 row inserted  -> this request owns the payment, proceed
--   -- 0 rows inserted -> SELECT the existing row and replay / 409 / 422

-- Load-test verification (expect exactly 1 for the shared key):
--
--   SELECT count(*) FROM payments WHERE idempotency_key = '<session-id>';

-- Recovery job: keys stuck in STARTED for over 2 minutes
--
--   SELECT idempotency_key FROM idempotency_keys
--   WHERE status = 'STARTED' AND locked_at < now() - INTERVAL '2 minutes'
--   FOR UPDATE SKIP LOCKED;

-- Cleanup job:
--
--   DELETE FROM idempotency_keys WHERE expires_at < now() AND status <> 'STARTED';
--   (payments keep their rows; deleting keys referenced by payments would
--    violate the FK, so in practice archive/soft-expire instead)
