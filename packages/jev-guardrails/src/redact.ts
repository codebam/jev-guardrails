/**
 * Secret redaction for state sent to Jev.
 *
 * Guardrail checks are most useful on realistic input, but prompts and tool
 * arguments often carry credentials. The built-in rules preserve the *shape*
 * that makes a credential dangerous (so the `secrets` and `exfiltration`
 * questions still fire) while replacing the value itself.
 *
 * @module @codebam/jev-guardrails/redact
 */
import type { RedactionPattern, RedactorOptions } from './types.js'
import { isRecord } from './util.js'

/** Built-in best-effort secret patterns. These are signals, not a scanner. */
export const DEFAULT_SECRET_PATTERNS: RedactionPattern[] = [
  {
    name: 'private-key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED:private-key]',
  },
  {
    name: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA|AROA|AIPA|ANPA|ANVA|APKA)[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED:aws-access-key]',
  },
  {
    name: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED:github-token]',
  },
  {
    name: 'github-pat',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replacement: '[REDACTED:github-pat]',
  },
  {
    name: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: '[REDACTED:slack-token]',
  },
  {
    name: 'openai-key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED:api-key]',
  },
  {
    name: 'anthropic-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED:api-key]',
  },
  {
    name: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g,
    replacement: '[REDACTED:api-key]',
  },
  {
    name: 'stripe-key',
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    replacement: '[REDACTED:stripe-key]',
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[REDACTED:jwt]',
  },
  {
    name: 'bearer-token',
    pattern: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})\b/gi,
    replacement: (_match, _scheme: string) => `Bearer [REDACTED:bearer-token]`,
  },
  {
    name: 'basic-auth',
    pattern: /\b(Basic\s+)([A-Za-z0-9+/=]{12,})\b/gi,
    replacement: (_match, _scheme: string) => `Basic [REDACTED:basic-auth]`,
  },
  {
    name: 'url-password',
    pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(@)/gi,
    replacement: (_match, prefix: string, _password: string, suffix: string) => `${prefix}[REDACTED:url-password]${suffix}`,
  },
  {
    name: 'assigned-secret',
    pattern: /([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|client[_-]?secret|secret|token|password|passwd|pwd|private[_-]?key))(\s*[:=]\s*)(["']?)([^\s"',;]{8,})(\3)/gi,
    replacement: (_match, key: string, separator: string, quote: string, _value: string) =>
      `${key}${separator}${quote}[REDACTED:assigned-secret]${quote}`,
  },
]

function replacementFor(pattern: RedactionPattern): string | ((substring: string, ...args: string[]) => string) {
  if (typeof pattern.replacement === 'function') {
    return pattern.replacement as (substring: string, ...args: string[]) => string
  }
  return pattern.replacement ?? `[REDACTED:${pattern.name}]`
}

/** Redact known secret shapes from one string. */
export function redactString(text: string, options: RedactorOptions = {}): string {
  const patterns = [
    ...(options.secrets === false ? [] : DEFAULT_SECRET_PATTERNS),
    ...(options.extraPatterns ?? []),
  ]
  let output = text
  for (const rule of patterns) {
    try {
      const replacement = replacementFor(rule)
      output = typeof replacement === 'string'
        ? output.replace(rule.pattern, replacement)
        : output.replace(rule.pattern, replacement)
    } catch {
      // A misbehaving custom pattern must never break a safety check.
    }
  }
  return output
}

/** Object keys whose values are secrets even without a recognizable value shape. */
const SENSITIVE_KEYS = /(?:^|[_-])(?:password|passwd|pwd|secret|token|api_?key|apikey|authorization|auth|cookie|private_?key|client_?secret|access_?key|session_?id)(?:$|[_-])/i

/** Recursively redact every string in a JSON-like value, preserving its shape. */
export function redactState<T>(state: T, options: RedactorOptions = {}): T {
  return redactValue(state, options) as T
}

function redactValue(value: unknown, options: RedactorOptions, key = ''): unknown {
  if (typeof value === 'string') {
    if (SENSITIVE_KEYS.test(key) && value.trim().length > 0 && !value.includes('[REDACTED:')) {
      return '[REDACTED:assigned-secret]'
    }
    return redactString(value, options)
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, options, key))
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [entryKey, entry] of Object.entries(value)) out[entryKey] = redactValue(entry, options, entryKey)
    return out
  }
  return value
}
