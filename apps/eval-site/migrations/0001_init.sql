-- eval.seanbehan.ca initial schema.
-- Monetary values are integer micro-credits: 1_000_000 micro = 1 credit,
-- so the 0.1 cache-hit charge is 100_000 and needs no floating point.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,
  display_name  TEXT,
  github_login  TEXT,
  plan          TEXT NOT NULL DEFAULT 'standard'
                  CHECK (plan IN ('standard', 'guard_credits')),
  credit_micros INTEGER NOT NULL DEFAULT 0 CHECK (credit_micros >= 0),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT,
  key_prefix   TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  plan         TEXT CHECK (plan IS NULL OR plan IN ('standard', 'guard_credits')),
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  evaluation_id       TEXT,
  kind                TEXT NOT NULL
                        CHECK (kind IN ('grant', 'reserve', 'refund', 'cache_hit', 'adjustment')),
  amount_micros       INTEGER NOT NULL, -- signed: negative debits, positive credits
  balance_after_micros INTEGER NOT NULL,
  note                TEXT,
  created_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_created
  ON credit_ledger(user_id, created_at);

CREATE TABLE IF NOT EXISTS evaluations (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id     TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  side           TEXT NOT NULL CHECK (side IN ('input', 'output', 'observation', 'action')),
  battery_id     TEXT NOT NULL,
  model          TEXT,
  request_hash   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'complete', 'cached', 'degraded', 'failed')),
  verdict_json   TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  cost_micros    INTEGER,
  degraded       INTEGER NOT NULL DEFAULT 0 CHECK (degraded IN (0, 1)),
  cached_hit     INTEGER NOT NULL DEFAULT 0 CHECK (cached_hit IN (0, 1)),
  error          TEXT,
  created_at     INTEGER NOT NULL,
  completed_at   INTEGER
);

-- Cache lookups are global (identical state + questions + model), newest first.
CREATE INDEX IF NOT EXISTS idx_evaluations_cache
  ON evaluations(request_hash, status, created_at);

CREATE INDEX IF NOT EXISTS idx_evaluations_user_created
  ON evaluations(user_id, created_at);
