/**
 * D1 implementation of {@link EvalStore}.
 *
 * Credits are stored as integer micro-credits (1 credit = 1_000_000 micro) so
 * the 0.1 cache-hit charge never accumulates floating-point drift. Debits use
 * a single conditional `UPDATE ... WHERE credit_micros >= ?`, which makes the
 * balance check and the deduction atomic inside D1.
 */
import type {
  Account,
  ApiKeyRecord,
  AuthRecord,
  CachedEvaluation,
  CreateAccountInput,
  CreateApiKeyInput,
  CreditPlan,
  D1Database,
  DebitResult,
  EvalStore,
  FinishEvaluationInput,
  LedgerEntryInput,
  ProcessStripeEventInput,
  ProcessStripeEventResult,
  ReserveInput,
  StartEvaluationInput,
} from './types.js'

interface AuthJoinRow {
  key_id: string
  key_user_id: string
  key_name: string | null
  key_prefix: string
  key_hash: string
  key_plan: string | null
  key_created_at: number
  key_last_used_at: number | null
  key_revoked_at: number | null
  account_email: string | null
  account_display_name: string | null
  account_github_id: string | null
  account_github_login: string | null
  account_plan: string
  credit_micros: number
  account_created_at: number
  account_updated_at: number
}

interface AccountRow {
  id: string
  email: string | null
  display_name: string | null
  github_id: string | null
  github_login: string | null
  plan: string
  credit_micros: number
  created_at: number
  updated_at: number
}

interface BalanceRow {
  balance: number
}

interface CachedRow {
  id: string
  verdict_json: string
  model: string | null
  created_at: number
}

const ACCOUNT_COLUMNS = `id, email, display_name, github_id, github_login, plan, credit_micros, created_at, updated_at`

/** Normalize a stored plan string, tolerating older rows. */
function planFrom(value: string | null | undefined): CreditPlan {
  return value === 'guard_credits' ? 'guard_credits' : 'standard'
}

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    githubId: row.github_id,
    githubLogin: row.github_login,
    plan: planFrom(row.plan),
    creditMicros: row.credit_micros,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapKey(row: AuthJoinRow): ApiKeyRecord {
  return {
    id: row.key_id,
    userId: row.key_user_id,
    name: row.key_name,
    keyPrefix: row.key_prefix,
    keyHash: row.key_hash,
    plan: row.key_plan === null ? null : planFrom(row.key_plan),
    createdAt: row.key_created_at,
    lastUsedAt: row.key_last_used_at,
    revokedAt: row.key_revoked_at,
  }
}

function authFrom(row: AuthJoinRow): AuthRecord {
  return {
    key: mapKey(row),
    account: {
      id: row.key_user_id,
      email: row.account_email,
      displayName: row.account_display_name,
      githubId: row.account_github_id,
      githubLogin: row.account_github_login,
      plan: planFrom(row.account_plan),
      creditMicros: row.credit_micros,
      createdAt: row.account_created_at,
      updatedAt: row.account_updated_at,
    },
  }
}

/** D1-backed account, key, ledger, evaluation, and cache storage. */
export class D1Store implements EvalStore {
  private readonly db: D1Database

  constructor(db: D1Database) {
    this.db = db
  }

  async findApiKeyByHash(keyHash: string): Promise<AuthRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT
           k.id            AS key_id,
           k.user_id       AS key_user_id,
           k.name          AS key_name,
           k.key_prefix    AS key_prefix,
           k.key_hash      AS key_hash,
           k.plan          AS key_plan,
           k.created_at    AS key_created_at,
           k.last_used_at  AS key_last_used_at,
           k.revoked_at    AS key_revoked_at,
           u.email         AS account_email,
           u.display_name  AS account_display_name,
           u.github_id     AS account_github_id,
           u.github_login  AS account_github_login,
           u.plan          AS account_plan,
           u.credit_micros AS credit_micros,
           u.created_at    AS account_created_at,
           u.updated_at    AS account_updated_at
         FROM api_keys k
         JOIN users u ON u.id = k.user_id
         WHERE k.key_hash = ?`,
      )
      .bind(keyHash)
      .first<AuthJoinRow>()
    return row === null ? null : authFrom(row)
  }

  async touchApiKey(apiKeyId: string, at: number): Promise<void> {
    await this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(at, apiKeyId).run()
  }

  async createAccount(input: CreateAccountInput): Promise<Account> {
    await this.db
      .prepare(
        `INSERT INTO users
           (id, email, display_name, github_id, github_login, plan, credit_micros, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .bind(
        input.id,
        input.email,
        input.displayName,
        input.githubId ?? null,
        input.githubLogin ?? null,
        input.plan,
        input.now,
        input.now,
      )
      .run()
    return {
      id: input.id,
      email: input.email,
      displayName: input.displayName,
      githubId: input.githubId ?? null,
      githubLogin: input.githubLogin ?? null,
      plan: input.plan,
      creditMicros: 0,
      createdAt: input.now,
      updatedAt: input.now,
    }
  }

  async findAccountByEmail(email: string): Promise<Account | null> {
    const row = await this.db
      .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM users WHERE lower(email) = lower(?)`)
      .bind(email)
      .first<AccountRow>()
    return row === null ? null : mapAccount(row)
  }

  async findAccountByGithubId(githubId: string): Promise<Account | null> {
    const row = await this.db
      .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM users WHERE github_id = ?`)
      .bind(githubId)
      .first<AccountRow>()
    return row === null ? null : mapAccount(row)
  }

  async getAccount(userId: string): Promise<Account | null> {
    const row = await this.db
      .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = ?`)
      .bind(userId)
      .first<AccountRow>()
    return row === null ? null : mapAccount(row)
  }

  async createApiKey(input: CreateApiKeyInput): Promise<ApiKeyRecord> {
    await this.db
      .prepare(
        `INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, plan, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(input.id, input.userId, input.name, input.keyPrefix, input.keyHash, input.plan, input.now)
      .run()
    return {
      id: input.id,
      userId: input.userId,
      name: input.name,
      keyPrefix: input.keyPrefix,
      keyHash: input.keyHash,
      plan: input.plan,
      createdAt: input.now,
      lastUsedAt: null,
      revokedAt: null,
    }
  }

  async applyLedgerEntry(input: LedgerEntryInput): Promise<{ balanceMicros: number }> {
    const updated = await this.db
      .prepare('UPDATE users SET credit_micros = credit_micros + ?, updated_at = ? WHERE id = ?')
      .bind(input.amountMicros, input.now, input.userId)
      .run()
    if ((updated.meta?.changes ?? 0) === 0) throw new Error(`account not found: ${input.userId}`)
    const balance = await this.readBalance(input.userId)
    await this.insertLedger(input, balance)
    return { balanceMicros: balance }
  }

  async reserveCredits(input: ReserveInput): Promise<DebitResult> {
    if (!Number.isInteger(input.amountMicros) || input.amountMicros <= 0) {
      throw new Error('reserveCredits requires a positive integer amount')
    }
    const updated = await this.db
      .prepare(
        `UPDATE users SET credit_micros = credit_micros - ?, updated_at = ?
         WHERE id = ? AND credit_micros >= ?`,
      )
      .bind(input.amountMicros, input.now, input.userId, input.amountMicros)
      .run()
    const balance = await this.readBalance(input.userId, (updated.meta?.changes ?? 0) === 0)
    if ((updated.meta?.changes ?? 0) === 0) return { ok: false, balanceMicros: balance }
    await this.insertLedger({ ...input, amountMicros: -input.amountMicros }, balance)
    return { ok: true, balanceMicros: balance }
  }

  async startEvaluation(input: StartEvaluationInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO evaluations
           (id, user_id, api_key_id, side, battery_id, model, request_hash, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .bind(
        input.id,
        input.userId,
        input.apiKeyId,
        input.side,
        input.batteryId,
        input.model,
        input.requestHash,
        input.now,
      )
      .run()
  }

  async finishEvaluation(input: FinishEvaluationInput): Promise<void> {
    const sets = ['status = ?', 'completed_at = ?']
    const params: unknown[] = [input.status, input.now]
    if (input.verdictJson !== undefined) {
      sets.push('verdict_json = ?')
      params.push(input.verdictJson)
    }
    if (input.model !== undefined) {
      sets.push('model = ?')
      params.push(input.model)
    }
    if (input.inputTokens !== undefined) {
      sets.push('input_tokens = ?')
      params.push(input.inputTokens)
    }
    if (input.outputTokens !== undefined) {
      sets.push('output_tokens = ?')
      params.push(input.outputTokens)
    }
    if (input.costMicros !== undefined) {
      sets.push('cost_micros = ?')
      params.push(input.costMicros)
    }
    if (input.degraded !== undefined) {
      sets.push('degraded = ?')
      params.push(input.degraded ? 1 : 0)
    }
    if (input.cachedHit !== undefined) {
      sets.push('cached_hit = ?')
      params.push(input.cachedHit ? 1 : 0)
    }
    if (input.error !== undefined) {
      sets.push('error = ?')
      params.push(input.error)
    }
    params.push(input.id)
    await this.db.prepare(`UPDATE evaluations SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run()
  }

  async processStripeEvent(input: ProcessStripeEventInput): Promise<ProcessStripeEventResult> {
    // One D1 batch is one transaction. `INSERT OR IGNORE` makes the event id
    // the idempotency key; the user update and ledger insert are guarded by
    // the event still being 'pending', so a duplicate delivery is a no-op.
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO stripe_events
             (id, type, session_id, user_id, credits_micros, status, created_at, processed_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`,
        )
        .bind(
          input.eventId,
          input.eventType,
          input.sessionId,
          input.userId,
          input.creditsMicros,
          input.now,
        ),
      this.db
        .prepare(
          `UPDATE users SET credit_micros = credit_micros + ?, updated_at = ?
           WHERE id = ?
             AND EXISTS (SELECT 1 FROM stripe_events WHERE id = ? AND status = 'pending')`,
        )
        .bind(input.creditsMicros, input.now, input.userId, input.eventId),
      this.db
        .prepare(
          `INSERT INTO credit_ledger
             (id, user_id, evaluation_id, kind, amount_micros, balance_after_micros, note, created_at)
           SELECT ?, ?, NULL, 'grant', ?, credit_micros, ?, ?
           FROM users
           WHERE id = ?
             AND EXISTS (SELECT 1 FROM stripe_events WHERE id = ? AND status = 'pending')`,
        )
        .bind(
          `stripe_${input.eventId}`,
          input.userId,
          input.creditsMicros,
          input.note ?? `Stripe credit grant ${input.eventId}`,
          input.now,
          input.userId,
          input.eventId,
        ),
      this.db
        .prepare(
          `UPDATE stripe_events SET status = 'processed', processed_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .bind(input.now, input.eventId),
    ])
    return { granted: (results[1]?.meta?.changes ?? 0) > 0 }
  }

  async findCachedEvaluation(input: {
    requestHash: string
    now: number
    ttlMs: number
  }): Promise<CachedEvaluation | null> {
    const since = input.now - input.ttlMs
    const row = await this.db
      .prepare(
        `SELECT id, verdict_json, model, created_at
         FROM evaluations
         WHERE request_hash = ?
           AND status = 'complete'
           AND cached_hit = 0
           AND verdict_json IS NOT NULL
           AND created_at >= ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .bind(input.requestHash, since)
      .first<CachedRow>()
    if (row === null) return null
    return {
      id: row.id,
      verdictJson: row.verdict_json,
      model: row.model,
      createdAt: row.created_at,
    }
  }

  private async readBalance(userId: string, allowMissing = false): Promise<number> {
    const row = await this.db
      .prepare('SELECT credit_micros AS balance FROM users WHERE id = ?')
      .bind(userId)
      .first<BalanceRow>()
    if (row === null) {
      if (allowMissing) return 0
      throw new Error(`account not found: ${userId}`)
    }
    return row.balance
  }

  private async insertLedger(input: LedgerEntryInput, balanceAfterMicros: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO credit_ledger
           (id, user_id, evaluation_id, kind, amount_micros, balance_after_micros, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        `${input.kind}_${crypto.randomUUID()}`,
        input.userId,
        input.evaluationId ?? null,
        input.kind,
        input.amountMicros,
        balanceAfterMicros,
        input.note ?? null,
        input.now,
      )
      .run()
  }
}
