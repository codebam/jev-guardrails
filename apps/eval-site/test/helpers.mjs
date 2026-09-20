/** Shared fakes for eval-site tests: memory store, mocked fetch, and SQLite D1. */
import { readFileSync } from 'node:fs'
import { sha256Hex } from '../dist/crypto.js'

export const CREDIT_MICROS = 1_000_000

/** In-memory EvalStore used by route tests. */
export class MemoryStore {
  constructor() {
    this.accounts = new Map()
    this.keysByHash = new Map()
    this.ledger = []
    this.evaluations = []
  }

  async findApiKeyByHash(keyHash) {
    const record = this.keysByHash.get(keyHash)
    if (record === undefined) return null
    const account = this.accounts.get(record.key.userId)
    if (account === undefined) return null
    return { key: { ...record.key }, account: { ...account } }
  }

  async touchApiKey(apiKeyId, at) {
    for (const record of this.keysByHash.values()) {
      if (record.key.id === apiKeyId) record.key.lastUsedAt = at
    }
  }

  async createAccount(input) {
    const account = {
      id: input.id,
      email: input.email,
      displayName: input.displayName,
      githubLogin: null,
      plan: input.plan,
      creditMicros: 0,
      createdAt: input.now,
      updatedAt: input.now,
    }
    this.accounts.set(account.id, account)
    return { ...account }
  }

  async findAccountByEmail(email) {
    for (const account of this.accounts.values()) {
      if (account.email !== null && account.email.toLowerCase() === email.toLowerCase()) return { ...account }
    }
    return null
  }

  async getAccount(userId) {
    const account = this.accounts.get(userId)
    return account === undefined ? null : { ...account }
  }

  async createApiKey(input) {
    const key = {
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
    this.keysByHash.set(key.keyHash, { key })
    return { ...key }
  }

  async applyLedgerEntry(input) {
    const account = this.accounts.get(input.userId)
    if (account === undefined) throw new Error(`account not found: ${input.userId}`)
    const next = account.creditMicros + input.amountMicros
    if (next < 0) throw new Error('credit_micros CHECK constraint failed')
    account.creditMicros = next
    account.updatedAt = input.now
    this.ledger.push({
      userId: input.userId,
      evaluationId: input.evaluationId ?? null,
      kind: input.kind,
      amountMicros: input.amountMicros,
      balanceAfterMicros: next,
      note: input.note ?? null,
      createdAt: input.now,
    })
    return { balanceMicros: next }
  }

  async reserveCredits(input) {
    const account = this.accounts.get(input.userId)
    if (account === undefined) return { ok: false, balanceMicros: 0 }
    if (account.creditMicros < input.amountMicros) {
      return { ok: false, balanceMicros: account.creditMicros }
    }
    account.creditMicros -= input.amountMicros
    account.updatedAt = input.now
    this.ledger.push({
      userId: input.userId,
      evaluationId: input.evaluationId ?? null,
      kind: input.kind,
      amountMicros: -input.amountMicros,
      balanceAfterMicros: account.creditMicros,
      note: input.note ?? null,
      createdAt: input.now,
    })
    return { ok: true, balanceMicros: account.creditMicros }
  }

  async startEvaluation(input) {
    this.evaluations.push({
      id: input.id,
      userId: input.userId,
      apiKeyId: input.apiKeyId,
      side: input.side,
      batteryId: input.batteryId,
      model: input.model,
      requestHash: input.requestHash,
      status: 'pending',
      verdictJson: null,
      modelResult: null,
      inputTokens: null,
      outputTokens: null,
      costMicros: null,
      degraded: 0,
      cachedHit: 0,
      error: null,
      createdAt: input.now,
      completedAt: null,
    })
  }

  async finishEvaluation(input) {
    const row = this.evaluations.find((entry) => entry.id === input.id)
    if (row === undefined) throw new Error(`evaluation not found: ${input.id}`)
    row.status = input.status
    row.completedAt = input.now
    if (input.verdictJson !== undefined) row.verdictJson = input.verdictJson
    if (input.model !== undefined) row.modelResult = input.model
    if (input.inputTokens !== undefined) row.inputTokens = input.inputTokens
    if (input.outputTokens !== undefined) row.outputTokens = input.outputTokens
    if (input.costMicros !== undefined) row.costMicros = input.costMicros
    if (input.degraded !== undefined) row.degraded = input.degraded ? 1 : 0
    if (input.cachedHit !== undefined) row.cachedHit = input.cachedHit ? 1 : 0
    if (input.error !== undefined) row.error = input.error
  }

  async findCachedEvaluation({ requestHash, now, ttlMs }) {
    const candidates = this.evaluations
      .filter(
        (row) =>
          row.requestHash === requestHash &&
          row.status === 'complete' &&
          row.cachedHit === 0 &&
          row.verdictJson !== null &&
          row.createdAt >= now - ttlMs,
      )
      .sort((a, b) => b.createdAt - a.createdAt)
    const row = candidates[0]
    return row === undefined
      ? null
      : { id: row.id, verdictJson: row.verdictJson, model: row.modelResult ?? row.model, createdAt: row.createdAt }
  }
}

/** Seed one account + one API key without going through /admin/keys. */
export async function seedKey(store, options = {}) {
  const credits = options.credits ?? 10
  const plan = options.plan ?? 'standard'
  const keyPlan = options.keyPlan ?? null
  const token = options.token ?? 'eval_seed_token'
  const userId = options.userId ?? 'user_seed'
  const email = options.email ?? `${userId}@example.com`
  const account = {
    id: userId,
    email,
    displayName: null,
    githubLogin: null,
    plan,
    creditMicros: Math.round(credits * CREDIT_MICROS),
    createdAt: 1_000,
    updatedAt: 1_000,
  }
  store.accounts.set(userId, account)
  const keyHash = await sha256Hex(token)
  const key = {
    id: `key_${userId}`,
    userId,
    name: 'seed',
    keyPrefix: `${token.slice(0, 12)}…`,
    keyHash,
    plan: keyPlan,
    createdAt: 1_000,
    lastUsedAt: null,
    revokedAt: null,
  }
  store.keysByHash.set(keyHash, { key })
  return { account, key, token }
}

/** Build a Worker env for tests. */
export function makeEnv(overrides = {}) {
  return {
    DB: undefined,
    OPENROUTER_API_KEY: 'test-openrouter-key',
    EVAL_ADMIN_TOKEN: 'admin-test-token',
    ...overrides,
  }
}

/** Call a Worker route. */
export async function callApi(app, env, method, path, options = {}) {
  const headers = new Headers(options.headers ?? {})
  headers.set('accept', 'application/json')
  if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`)
  const init = { method, headers }
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json')
    init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
  }
  const response = await app.fetch(new Request(`https://eval.test${path}`, init), env)
  const text = await response.text()
  let body
  try {
    body = text.length > 0 ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: response.status, headers: response.headers, body }
}

/** Default provider answers for the given question object. */
export function answersFor(questions, overrides = {}) {
  const answers = {}
  for (const [name, question] of Object.entries(questions)) {
    if (Object.prototype.hasOwnProperty.call(overrides, name)) {
      answers[name] = overrides[name]
      continue
    }
    if (question.type === 'noul') {
      answers[name] = noulAnswer(0.01)
    } else if (question.type === 'score') {
      answers[name] = scoreAnswer(0)
    } else {
      const labels = Object.keys(question.criteria)
      answers[name] = {
        type: 'choice',
        choice: labels[0],
        confidence: 0.9,
        probabilities: Object.fromEntries(labels.map((label) => [label, 1 / labels.length])),
      }
    }
  }
  return answers
}

export function noulAnswer(probability) {
  return { type: 'noul', noul: probability }
}

export function scoreAnswer(score, confidence = 0.9) {
  return {
    type: 'score',
    score,
    confidence,
    legend: { 0: 'none', 1: 'low', 2: 'serious', 3: 'severe' },
    probabilities: { 0: 0.1, 1: 0.1, 2: 0.3, 3: 0.5 },
  }
}

/**
 * Mock upstream fetch. Returns `{ fetch, calls }`; `calls[i].body` is the
 * parsed Decisions request. `answers` may be an object or a function.
 */
export function makeUpstream(options = {}) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ url: String(url), init, body })
    if (typeof options.bodyHook === 'function') {
      const custom = await options.bodyHook(body, calls.length)
      if (custom !== undefined) return custom
    }
    if (options.fail !== undefined && options.fail !== false) {
      throw new Error(options.fail === true ? 'upstream exploded' : String(options.fail))
    }
    if (options.status !== undefined && options.status !== 200) {
      return new Response(
        JSON.stringify({ error: { message: options.errorMessage ?? 'upstream failed' } }),
        { status: options.status, headers: { 'content-type': 'application/json' } },
      )
    }
    const answers =
      typeof options.answers === 'function'
        ? options.answers(body.questions, body)
        : options.answers ?? answersFor(body.questions)
    return new Response(
      JSON.stringify({
        model: options.model ?? 'typesafe/jev-1.13-20260917',
        answers,
        usage: options.usage ?? { input_tokens: 900, output_tokens: 120, cost: 0.00004 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  return { fetch, calls }
}

/** A fetch that fails the test if it is ever called. */
export async function throwIfCalled(url) {
  throw new Error(`unexpected upstream fetch: ${String(url)}`)
}

class SqlitePreparedStatement {
  constructor(db, sql, params = []) {
    this.db = db
    this.sql = sql
    this.params = params
  }

  bind(...values) {
    return new SqlitePreparedStatement(this.db, this.sql, values.map(normalizeValue))
  }

  async first() {
    const row = this.db.prepare(this.sql).get(...this.params)
    return row === undefined ? null : normalizeRow(row)
  }

  async run() {
    const result = this.db.prepare(this.sql).run(...this.params)
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
    }
  }

  async all() {
    const rows = this.db.prepare(this.sql).all(...this.params)
    return { success: true, meta: { changes: 0 }, results: rows.map(normalizeRow) }
  }
}

class SqliteD1 {
  constructor(db) {
    this.db = db
  }

  prepare(sql) {
    return new SqlitePreparedStatement(this.db, sql)
  }

  async batch(statements) {
    this.db.exec('BEGIN')
    try {
      const results = []
      for (const statement of statements) results.push(await statement.run())
      this.db.exec('COMMIT')
      return results
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  async exec(sql) {
    this.db.exec(sql)
    return { count: 0, duration: 0 }
  }
}

function normalizeValue(value) {
  if (value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  return value
}

function normalizeRow(row) {
  const normalized = {}
  for (const [key, value] of Object.entries(row)) {
    normalized[key] = typeof value === 'bigint' ? Number(value) : value
  }
  return normalized
}

/**
 * Build a D1-compatible adapter over in-memory SQLite and apply the real
 * migration. Returns null when node:sqlite is unavailable (Node < 22.5).
 */
export async function createSqliteD1() {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(':memory:')
    const migration = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(migration)
    return { d1: new SqliteD1(db), db }
  } catch (error) {
    if (error?.code === 'ERR_UNKNOWN_BUILTIN_MODULE' || error?.code === 'ERR_MODULE_NOT_FOUND') return null
    throw error
  }
}
