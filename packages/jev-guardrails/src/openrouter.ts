/**
 * OpenRouter Decisions API transport.
 *
 * OpenRouter exposes TypeSafe Jev through `POST /api/alpha/decisions`, a
 * structured-decisions endpoint with the same question and answer shapes the
 * TypeSafe System One API uses. It is not the OpenAI-compatible chat endpoint,
 * so the official TypeSafe SDK cannot be used for it.
 *
 * @see https://openrouter.ai/docs
 * @module @codebam/jev-guardrails/openrouter
 */
import type { Fetch, Questions, RequestOptions, RetryPolicy, SystemOneRequest, SystemOneResult } from '@typesafe-ai/sdk'

/** Default endpoint. */
export const OPENROUTER_DECISIONS_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'

/** Default OpenRouter model alias for the latest Jev. */
export const OPENROUTER_DEFAULT_MODEL = '~typesafe/jev-latest'

/** Friendly model names mapped to OpenRouter slugs. */
const OPENROUTER_MODEL_ALIASES: Record<string, string> = {
  'jev-latest': OPENROUTER_DEFAULT_MODEL,
  'typesafe/jev-latest': OPENROUTER_DEFAULT_MODEL,
  '~typesafe/jev-latest': OPENROUTER_DEFAULT_MODEL,
  'jev-1.13': 'typesafe/jev-1.13',
  'typesafe/jev-1.13': 'typesafe/jev-1.13',
}

/** Error raised for a non-2xx OpenRouter response after retries. */
export class OpenRouterError extends Error {
  readonly status: number
  readonly body: string

  constructor(status: number, message: string, body = '') {
    super(message)
    this.name = 'OpenRouterError'
    this.status = status
    this.body = body
  }
}

/** Options for {@link OpenRouterDecisionsTransport}. */
export interface OpenRouterTransportOptions {
  /** OpenRouter API key. Required. */
  apiKey: string
  /** Full Decisions endpoint or an origin/base URL that resolves to it. */
  baseURL?: string
  /** Default model when a request omits one. */
  model?: string
  /** Fetch implementation. Default: global fetch. */
  fetch?: Fetch
  /** Retry overrides. Defaults match the TypeSafe SDK's retry policy. */
  retry?: Partial<RetryPolicy>
  /** Optional OpenRouter session id for observability grouping. */
  sessionId?: string
  /** Extra request headers. */
  headers?: Record<string, string>
  /** Optional OpenRouter `HTTP-Referer` attribution header. */
  referer?: string
  /** Optional OpenRouter `X-Title` attribution header. */
  title?: string
}

const DEFAULT_RETRY: RetryPolicy = {
  maxRetries: 2,
  backoffInitialMs: 500,
  backoffMaxMs: 5000,
  backoffJitter: 0.25,
  httpStatuses: new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]),
  respectRetryAfter: true,
  maxRetryAfterMs: 60000,
  apiConnectionError: true,
  apiTimeoutError: true,
}

/** Resolve a friendly Jev name to an OpenRouter model slug. */
export function normalizeOpenRouterModel(model?: string): string {
  const trimmed = model?.trim() ?? ''
  if (trimmed.length === 0) return OPENROUTER_DEFAULT_MODEL
  const alias = OPENROUTER_MODEL_ALIASES[trimmed.toLowerCase()]
  if (alias !== undefined) return alias
  if (trimmed.includes('/')) return trimmed
  return `typesafe/${trimmed}`
}

/** Resolve a caller base URL to the exact Decisions endpoint. */
export function resolveOpenRouterEndpoint(baseURL?: string): string {
  const trimmed = baseURL?.trim().replace(/\/+$/, '') ?? ''
  if (trimmed.length === 0) return OPENROUTER_DECISIONS_ENDPOINT
  if (trimmed.endsWith('/decisions')) return trimmed
  if (trimmed.endsWith('/api/alpha')) return `${trimmed}/decisions`
  if (!/\/api\//.test(trimmed)) return `${trimmed}/api/alpha/decisions`
  return trimmed
}

/** OpenRouter Decisions transport implementing the library's `JevTransport`. */
export class OpenRouterDecisionsTransport {
  private readonly endpoint: string
  private readonly model: string
  private readonly apiKey: string
  private readonly fetchImpl: Fetch
  private readonly retry: RetryPolicy
  private readonly sessionId: string | undefined
  private readonly headers: Record<string, string>

  constructor(options: OpenRouterTransportOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new OpenRouterError(401, 'OpenRouter API key is missing')
    }
    this.endpoint = resolveOpenRouterEndpoint(options.baseURL)
    this.model = options.model?.trim() ?? OPENROUTER_DEFAULT_MODEL
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.retry = { ...DEFAULT_RETRY, ...options.retry, httpStatuses: options.retry?.httpStatuses ?? DEFAULT_RETRY.httpStatuses }
    this.sessionId = options.sessionId
    this.headers = {
      ...(options.referer !== undefined ? { 'HTTP-Referer': options.referer } : {}),
      ...(options.title !== undefined ? { 'X-Title': options.title } : {}),
      ...(options.headers ?? {}),
    }
  }

  /** Submit one Decisions request and return the normalized response. */
  async systemOne<Q extends Questions>(
    request: SystemOneRequest<Q>,
    options: RequestOptions = {},
  ): Promise<SystemOneResult<Q>> {
    const model = normalizeOpenRouterModel(request.model ?? this.model)
    const body: Record<string, unknown> = {
      model,
      state: request.state,
      questions: request.questions,
    }
    if (this.sessionId !== undefined) body.session_id = this.sessionId

    let attempt = 0
    for (;;) {
      const response = await this.fetchOnce(body, options)
      if (response.ok) {
        return (await response.json()) as SystemOneResult<Q>
      }
      const text = await response.text().catch(() => '')
      if (attempt < this.retry.maxRetries && this.retry.httpStatuses.has(response.status)) {
        await sleep(this.retryDelay(attempt, response.headers))
        attempt += 1
        continue
      }
      throw new OpenRouterError(response.status, describeError(response.status, text), text)
    }
  }

  private async fetchOnce(body: Record<string, unknown>, options: RequestOptions): Promise<Response> {
    try {
      return await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          ...this.headers,
          ...(options.headers ?? {}),
        },
        body: JSON.stringify(body),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      })
    } catch (error) {
      if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      const retry = this.retry
      if (retry.apiConnectionError) {
        // One bounded connection-retry loop; the abort check above keeps
        // cancellation immediate.
        let attempt = 0
        while (attempt < retry.maxRetries) {
          await sleep(this.retryDelay(attempt))
          attempt += 1
          try {
            return await this.fetchImpl(this.endpoint, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${this.apiKey}`,
                'content-type': 'application/json',
                accept: 'application/json',
                ...this.headers,
                ...(options.headers ?? {}),
              },
              body: JSON.stringify(body),
              ...(options.signal !== undefined ? { signal: options.signal } : {}),
            })
          } catch (retryError) {
            if (options.signal?.aborted || (retryError instanceof Error && retryError.name === 'AbortError')) throw retryError
          }
        }
      }
      throw error
    }
  }

  private retryDelay(attempt: number, headers?: Headers): number {
    if (headers !== undefined && this.retry.respectRetryAfter) {
      const retryAfterMs = parseRetryAfter(headers.get('retry-after'), headers.get('retry-after-ms'))
      if (retryAfterMs !== undefined) return Math.min(retryAfterMs, this.retry.maxRetryAfterMs)
    }
    const base = Math.min(this.retry.backoffInitialMs * 2 ** attempt, this.retry.backoffMaxMs)
    const jitter = base * this.retry.backoffJitter * Math.random()
    return Math.max(0, Math.round(base - jitter))
  }
}

/** Build an OpenRouter Decisions transport. */
export function createOpenRouterTransport(options: OpenRouterTransportOptions): OpenRouterDecisionsTransport {
  return new OpenRouterDecisionsTransport(options)
}

function parseRetryAfter(secondsHeader: string | null, msHeader: string | null): number | undefined {
  if (msHeader !== null) {
    const ms = Number(msHeader)
    if (Number.isFinite(ms) && ms >= 0) return ms
  }
  if (secondsHeader !== null) {
    const seconds = Number(secondsHeader)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    const date = Date.parse(secondsHeader)
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  }
  return undefined
}

function describeError(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown }
    const message = parsed.error?.message ?? parsed.message
    if (typeof message === 'string') return `OpenRouter Decisions request failed (${status}): ${message}`
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return `OpenRouter Decisions request failed (${status})${text.length > 0 ? `: ${text.slice(0, 300)}` : ''}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
