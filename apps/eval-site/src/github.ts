/**
 * GitHub Device Flow proxy.
 *
 * The flow is public-client-only: no GitHub client secret is required or
 * stored. Access tokens are used in-memory for two GitHub API calls and are
 * never logged, persisted, or returned to the caller.
 */
import type { Env } from './types.js'

/** Failure talking to GitHub. `status` is the nearest HTTP status to return. */
export class GithubError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, message: string, body: unknown = null) {
    super(message)
    this.name = 'GithubError'
    this.status = status
    this.body = body
  }
}

/** A GitHub OAuth error payload (`authorization_pending`, `slow_down`, ...). */
export interface GithubTokenExchange {
  /** GitHub's OAuth error object, returned verbatim to the polling client. */
  oauthError: Record<string, unknown> | null
  /** Present only on success. Never forwarded or persisted. */
  accessToken: string | null
}

/** The identity fields the service keeps from GitHub. */
export interface GithubIdentity {
  githubId: string
  login: string
  displayName: string | null
  email: string | null
}

/** Client contract; injected into the app so tests can mock upstream fetch. */
export interface GithubClient {
  startDevice(clientId: string, scope?: string): Promise<Record<string, unknown>>
  exchangeDeviceCode(input: {
    clientId: string
    deviceCode: string
    grantType: string
  }): Promise<GithubTokenExchange>
  fetchIdentity(accessToken: string): Promise<GithubIdentity>
}

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const USER_URL = 'https://api.github.com/user'
const EMAILS_URL = 'https://api.github.com/user/emails'
const USER_AGENT = 'eval-site (+https://eval.seanbehan.ca)'
const API_VERSION = '2022-11-28'

/** Build a GitHub client backed by the supplied `fetch`. */
export function createGithubClient(fetchImpl: typeof globalThis.fetch): GithubClient {
  async function request(url: string, init: RequestInit, context: string): Promise<{ ok: boolean; status: number; body: unknown }> {
    let response: Response
    try {
      response = await fetchImpl(url, init)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new GithubError(502, `${context} request failed: ${message}`)
    }
    let text = ''
    try {
      text = await response.text()
    } catch {
      // Leave the body empty; the status/JSON handling below still applies.
    }
    let body: unknown = null
    if (text.length > 0) {
      try {
        body = JSON.parse(text)
      } catch {
        throw new GithubError(502, `${context} returned invalid JSON`)
      }
    }
    return { ok: response.ok, status: response.status, body }
  }

  async function fetchPrimaryEmail(accessToken: string): Promise<string | null> {
    const { ok, body } = await request(
      EMAILS_URL,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/vnd.github+json',
          'user-agent': USER_AGENT,
          'x-github-api-version': API_VERSION,
        },
      },
      'GitHub user emails',
    )
    if (!ok || !Array.isArray(body)) return null
    const emails = body.filter(isRecord)
    const primary = emails.find((entry) => entry.primary === true && entry.verified === true)
    const candidate = primary ?? emails.find((entry) => entry.verified === true)
    return candidate !== undefined && typeof candidate.email === 'string' && candidate.email.length > 0
      ? candidate.email.toLowerCase()
      : null
  }

  return {
    async startDevice(clientId: string, scope?: string): Promise<Record<string, unknown>> {
      const payload: Record<string, string> = { client_id: clientId }
      if (scope !== undefined && scope.length > 0) payload.scope = scope
      const { ok, status, body } = await request(
        DEVICE_CODE_URL,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'user-agent': USER_AGENT,
          },
          body: JSON.stringify(payload),
        },
        'GitHub device-code',
      )
      if (!isRecord(body)) throw new GithubError(502, 'GitHub device-code response was not an object')
      if (typeof body.error === 'string') {
        throw new GithubError(ok ? 400 : 502, githubMessage(body) ?? 'GitHub rejected the device-code request', body)
      }
      if (!ok) throw new GithubError(502, `GitHub device-code request failed (${status})`, body)
      if (
        typeof body.device_code !== 'string' ||
        typeof body.user_code !== 'string' ||
        typeof body.verification_uri !== 'string'
      ) {
        throw new GithubError(502, 'GitHub device-code response is missing required fields', body)
      }
      return body
    },

    async exchangeDeviceCode(input: {
      clientId: string
      deviceCode: string
      grantType: string
    }): Promise<GithubTokenExchange> {
      const { ok, status, body } = await request(
        ACCESS_TOKEN_URL,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'user-agent': USER_AGENT,
          },
          body: JSON.stringify({
            client_id: input.clientId,
            device_code: input.deviceCode,
            grant_type: input.grantType,
          }),
        },
        'GitHub token exchange',
      )
      if (!isRecord(body)) throw new GithubError(502, 'GitHub token exchange returned a non-object response')
      // OAuth polling errors (authorization_pending, slow_down, expired_token,
      // access_denied) are data for the client, not proxy failures.
      if (typeof body.error === 'string') return { oauthError: body, accessToken: null }
      if (!ok) throw new GithubError(502, `GitHub token exchange failed (${status})`, body)
      if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
        throw new GithubError(502, 'GitHub token exchange returned no access_token', body)
      }
      return { oauthError: null, accessToken: body.access_token }
    },

    async fetchIdentity(accessToken: string): Promise<GithubIdentity> {
      const { ok, status, body } = await request(
        USER_URL,
        {
          method: 'GET',
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: 'application/vnd.github+json',
            'user-agent': USER_AGENT,
            'x-github-api-version': API_VERSION,
          },
        },
        'GitHub user lookup',
      )
      if (!ok) throw new GithubError(502, `GitHub user lookup failed (${status})`, body)
      if (!isRecord(body)) throw new GithubError(502, 'GitHub user lookup returned a non-object response')
      const rawId = body.id
      const githubId = typeof rawId === 'number' || typeof rawId === 'string' ? String(rawId) : ''
      const login = typeof body.login === 'string' && body.login.length > 0 ? body.login : ''
      if (githubId.length === 0 || login.length === 0) {
        throw new GithubError(502, 'GitHub user lookup response is missing id or login', body)
      }
      const displayName = typeof body.name === 'string' && body.name.length > 0 ? body.name : null
      const email =
        typeof body.email === 'string' && body.email.length > 0 ? body.email.toLowerCase() : await fetchPrimaryEmail(accessToken)
      return { githubId, login, displayName, email }
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function githubMessage(body: Record<string, unknown>): string | null {
  const message = body.error_description ?? body.message
  return typeof message === 'string' && message.length > 0 ? message : null
}

/** Read the GitHub client id from env, optionally cross-checking a request value. */
export function resolveGithubClientId(env: Env, requested: unknown): { clientId: string; error: string | null } {
  const configured = env.GITHUB_CLIENT_ID?.trim()
  if (configured === undefined || configured.length === 0) {
    return { clientId: '', error: 'GITHUB_CLIENT_ID is not configured' }
  }
  if (requested === undefined || requested === null || requested === '') {
    return { clientId: configured, error: null }
  }
  if (typeof requested !== 'string' || requested.trim() !== configured) {
    return { clientId: '', error: 'client_id does not match this service' }
  }
  return { clientId: configured, error: null }
}
