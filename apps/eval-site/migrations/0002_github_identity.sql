-- GitHub device-flow identity and Stripe credit packs.
--
-- D1 migrations run once, so the non-idempotent ALTER TABLE is safe here.
-- `github_id` is stored as TEXT so large GitHub ids survive JSON/SQL coerced
-- through JavaScript numbers.

ALTER TABLE users ADD COLUMN github_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id);

-- Exactly-once ledger for Stripe webhook deliveries. The row is inserted with
-- `INSERT OR IGNORE` in the same D1 batch as the credit grant, so duplicate
-- deliveries can neither double-grant nor lose a grant on retry.
CREATE TABLE IF NOT EXISTS stripe_events (
  id             TEXT PRIMARY KEY,        -- Stripe event id (evt_...)
  type           TEXT NOT NULL,
  session_id     TEXT,                    -- cs_... checkout session
  user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  credits_micros INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'processed')),
  created_at     INTEGER NOT NULL,
  processed_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_stripe_events_session ON stripe_events(session_id);
CREATE INDEX IF NOT EXISTS idx_stripe_events_user ON stripe_events(user_id, created_at);
