/**
 * HTTP client for the hosted eval.seanbehan.ca guardrails service.
 *
 * Every method authenticates with `Authorization: Bearer eval_...` and
 * resolves its base URL/key from explicit options, the environment, then
 * `~/.config/eval-jev/config.json`.
 *
 * @module @codebam/eval-jev-guardrails/client
 */
import { EvalConfigError, resolveEvalConfig } from './config.js'
import type { EvalResolvedConfig } from './types.js'
import type {
  EvalActionDescriptor,
  EvalClientOptions,
  EvalCreditsResponse,
  EvalEvaluation,
  EvalMeResponse,
  EvalSide,
  EvalSystemOneRequest,
  EvalSystemOneResponse,
} from './types.js'
import { PACKAGE_VERSION } from './version.js'

export { EvalConfigError }

/** The service is unreachable, timed out, or returned a non-JSON body. */
export class EvalTransportError extends Error {
  readonly code = 'EVAL_TRANSPORT'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EvalTransportError'
  }
}

/** The service answered with a non-2xx status. */
export class EvalApiError extends Error {
  readonly code = 'EVAL_API'
  readonly status: number
  readonly apiCode: string | undefined
  readonly body: unknown

  constructor(status: number, message: string, options: { apiCode?: string; body?: unknown } = {}) {
    super(message)
    this.name = 'EvalApiError'
    this.status = status
    this.apiCode = options.apiCode
    this.body = options.body
  }
}

const SIDES: readonly EvalSide[] = ['input', 'output', 'observation', 'action']

/** Options accepted by {@link EvalGuardrailsClient}. */
export type EvalGuardrailsClientOptions = EvalClientOptions

/**
 * Client for `/v1/evaluate`, `/v1/systemone`, `/v1/credits`, and `/v1/me`.
 *
 * The client is cheap to construct; hooks create one lazily so a `login` that
 * happens after a harness starts is picked up on the next tool call.
 */
export class EvalGuardrailsClient {
  private readonly resolved: EvalResolvedConfig
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly timeoutMs: number
  private readonly headers: Record<string, string>
  private readonly userAgent: string

  constructor(options: EvalGuardrailsClientOptions = {}) {
    this.resolved = resolveEvalConfig(options)
    const fetchImpl = options.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      throw new EvalConfigError('global fetch is not available; Node.js 20 or newer is required')
    }
    this.fetchImpl = fetchImpl
    this.timeoutMs = resolveTimeout(options)
    this.headers = { ...(options.headers ?? {}) }
    this.userAgent = options.userAgent ?? `@codebam/eval-jev-guardrails/${PACKAGE_VERSION}`
  }

  /** Fully resolved configuration (key masked only when the caller prints it). */
  get config(): EvalResolvedConfig {
    return this.resolved
  }

  /** Base URL used for requests. */
  get baseUrl(): string {
    return this.resolved.baseUrl
  }

  /** True when a key was resolved from an option, the environment, or the config file. */
  get hasApiKey(): boolean {
    return this.resolved.apiKey !== undefined
  }

  /**
   * Screen one side of an agent loop.
   *
   * `action` is required when `side === 'action'`; the service ignores it
   * otherwise.
   */
  async evaluate(side: EvalSide, state: unknown, action?: EvalActionDescriptor): Promise<EvalEvaluation> {
    if (!SIDES.includes(side)) {
      throw new EvalConfigError(`side must be one of ${SIDES.join(', ')}; received ${JSON.stringify(side)}`)
    }
    if (side === 'action' && action === undefined) {
      throw new EvalConfigError('an action descriptor is required when side is "action"')
    }
    const body: Record<string, unknown> = { side, state }
    if (action !== undefined) body.action = action
    return this.request<EvalEvaluation>('/v1/evaluate', { method: 'POST', body, operation: 'evaluate' })
  }

  /** Call the SystemOne-compatible endpoint used by the hosted provider. */
  async systemOne(request: EvalSystemOneRequest): Promise<EvalSystemOneResponse> {
    if (request === null || typeof request !== 'object') {
      throw new EvalConfigError('systemOne requires a request object')
    }
    return this.request<EvalSystemOneResponse>('/v1/systemone', { method: 'POST', body: request, operation: 'systemOne' })
  }

  /** Read the authenticated account. */
  async me(): Promise<EvalMeResponse> {
    return this.request<EvalMeResponse>('/v1/me', { method: 'GET', operation: 'me' })
  }

  /** Read the current credit balance. */
  async credits(): Promise<EvalCreditsResponse> {
    return this.request<EvalCreditsResponse>('/v1/credits', { method: 'GET', operation: 'credits' })
  }

  private requireApiKey(operation: string): string {
    const apiKey = this.resolved.apiKey
    if (apiKey === undefined) {
      throw new EvalConfigError(
        `no eval API key is configured for ${operation}; set EVAL_API_KEY, pass apiKey, or run \`eval-jev login --token eval_...\` (config: ${this.resolved.configPath})`,
      )
    }
    return apiKey
  }

  private async request<T>(
    path: string,
    options: { method: 'GET' | 'POST'; body?: unknown; operation: string },
  ): Promise<T> {
    const apiKey = this.requireApiKey(options.operation)
    const url = `${this.resolved.baseUrl}${path}`
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': this.userAgent,
      ...this.headers,
    }
    let payload: string | undefined
    if (options.body !== undefined) {
      payload = JSON.stringify(options.body)
      headers['Content-Type'] = 'application/json'
    }

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: options.method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new EvalTransportError(`could not reach the eval service at ${url}: ${detail}`, { cause: error })
    }

    const text = await response.text().catch(() => '')
    const parsed = parseBody(text)
    if (!response.ok) {
      throw new EvalApiError(
        response.status,
        apiErrorMessage(response.status, url, parsed, text),
        { apiCode: apiErrorCode(parsed), body: parsed ?? text },
      )
    }
    if (parsed === undefined) {
      if (text.trim().length === 0) return {} as T
      throw new EvalTransportError(`the eval service returned a non-JSON body from ${url}`)
    }
    return parsed as T
  }
}

function resolveTimeout(options: EvalClientOptions): number {
  if (options.timeoutMs !== undefined) return normalizeTimeout(options.timeoutMs, 'timeoutMs')
  const envValue = (options.env ?? process.env).EVAL_TIMEOUT_MS
  if (envValue !== undefined && envValue.trim().length > 0) {
    return normalizeTimeout(Number(envValue), 'EVAL_TIMEOUT_MS')
  }
  return 5000
}

function normalizeTimeout(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new EvalConfigError(`${label} must be a positive number of milliseconds`)
  }
  return Math.max(100, Math.floor(value))
}

function parseBody(text: string): unknown {
  if (text.trim().length === 0) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function apiErrorCode(parsed: unknown): string | undefined {
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  const code = record.code ?? record.error_code
  if (typeof code === 'string' && code.length > 0) return code
  const error = record.error
  if (error !== null && typeof error === 'object') {
    const nested = (error as Record<string, unknown>).code
    if (typeof nested === 'string' && nested.length > 0) return nested
  }
  return undefined
}

function apiErrorMessage(status: number, url: string, parsed: unknown, raw: string): string {
  let detail: string | undefined
  if (parsed !== null && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>
    if (typeof record.message === 'string' && record.message.length > 0) detail = record.message
    if (typeof record.error === 'string' && record.error.length > 0) detail = record.error
    if (detail === undefined && record.error !== null && typeof record.error === 'object') {
      const nested = (record.error as Record<string, unknown>).message
      if (typeof nested === 'string' && nested.length > 0) detail = nested
    }
  }
  if (detail === undefined && raw.trim().length > 0 && raw.trim().length <= 300) detail = raw.trim()
  return `eval service request to ${url} failed with HTTP ${status}${detail !== undefined ? `: ${detail}` : ''}`
}
