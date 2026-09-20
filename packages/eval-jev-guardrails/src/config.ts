/**
 * Configuration resolution and persistence for `~/.config/eval-jev/config.json`.
 *
 * Precedence is documented per field and used everywhere (client, CLI, hooks):
 * explicit options, then `EVAL_API_KEY` / `EVAL_BASE_URL` / `EVAL_CONFIG_PATH`
 * from the environment, then the config file, then the built-in base URL.
 *
 * @module @codebam/eval-jev-guardrails/config
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_BASE_URL } from './version.js'
import type { EvalConfigSource, EvalResolvedConfig } from './types.js'

/** Error raised for unreadable or malformed client configuration. */
export class EvalConfigError extends Error {
  readonly code = 'EVAL_CONFIG'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EvalConfigError'
  }
}

/** Options for {@link resolveEvalConfig}. */
export interface ResolveEvalConfigOptions {
  apiKey?: string
  baseUrl?: string
  configPath?: string
  env?: NodeJS.ProcessEnv
  /** Home directory used when `EVAL_CONFIG_PATH` / `XDG_CONFIG_HOME` are unset. */
  home?: string
}

/** Options for {@link writeEvalConfig}. */
export interface WriteEvalConfigOptions extends ResolveEvalConfigOptions {
  /** Merge with an existing file instead of replacing it. Default: true. */
  merge?: boolean
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
}

function asString(value: unknown): string | undefined {
  return nonEmpty(typeof value === 'string' ? value : undefined)
}

/** Resolve the config file path: `EVAL_CONFIG_PATH` > `$XDG_CONFIG_HOME/eval-jev/config.json` > `~/.config/eval-jev/config.json`. */
export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const explicit = nonEmpty(env.EVAL_CONFIG_PATH)
  if (explicit !== undefined) return explicit
  const xdg = nonEmpty(env.XDG_CONFIG_HOME)
  const base = xdg ?? join(home, '.config')
  return join(base, 'eval-jev', 'config.json')
}

/** Read and parse the config file. Returns `undefined` when it does not exist. */
export function readEvalConfigFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new EvalConfigError(`could not read the eval config file at ${path}: ${errorMessage(error)}`, { cause: error })
  }
  if (raw.trim().length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new EvalConfigError(`the eval config file at ${path} is not valid JSON: ${errorMessage(error)}`, { cause: error })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EvalConfigError(`the eval config file at ${path} must contain a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/** Resolve key and base URL with documented precedence. Never throws for a missing file/key. */
export function resolveEvalConfig(options: ResolveEvalConfigOptions = {}): EvalResolvedConfig {
  const env = options.env ?? process.env
  const configPath = nonEmpty(options.configPath) ?? defaultConfigPath(env, options.home)
  const file = readEvalConfigFile(configPath)

  const fileKey = asString(file?.apiKey)
  const fileBase = asString(file?.baseUrl) ?? asString(file?.baseURL)

  const optionKey = nonEmpty(options.apiKey)
  const envKey = nonEmpty(env.EVAL_API_KEY)
  const optionBase = nonEmpty(options.baseUrl)
  const envBase = nonEmpty(env.EVAL_BASE_URL)

  let apiKey: string | undefined
  let apiKeySource: EvalConfigSource
  if (optionKey !== undefined) {
    apiKey = optionKey
    apiKeySource = 'option'
  } else if (envKey !== undefined) {
    apiKey = envKey
    apiKeySource = 'env'
  } else if (fileKey !== undefined) {
    apiKey = fileKey
    apiKeySource = 'config'
  } else {
    apiKey = undefined
    apiKeySource = 'missing'
  }

  let baseUrl: string
  let baseUrlSource: EvalConfigSource
  if (optionBase !== undefined) {
    baseUrl = optionBase
    baseUrlSource = 'option'
  } else if (envBase !== undefined) {
    baseUrl = envBase
    baseUrlSource = 'env'
  } else if (fileBase !== undefined) {
    baseUrl = fileBase
    baseUrlSource = 'config'
  } else {
    baseUrl = DEFAULT_BASE_URL
    baseUrlSource = 'default'
  }

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    configPath,
    apiKeySource,
    baseUrlSource,
    file,
  }
}

/** Merge and persist config values with mode 600 (directories mode 700). */
export function writeEvalConfig(
  values: { apiKey?: string; baseUrl?: string },
  options: WriteEvalConfigOptions = {},
): string {
  const env = options.env ?? process.env
  const configPath = nonEmpty(options.configPath) ?? defaultConfigPath(env, options.home)
  const existing = options.merge === false ? {} : (readEvalConfigFile(configPath) ?? {})
  const next: Record<string, unknown> = { ...existing }
  const apiKey = nonEmpty(values.apiKey)
  const baseUrl = nonEmpty(values.baseUrl)
  if (apiKey !== undefined) next.apiKey = apiKey
  if (baseUrl !== undefined) next.baseUrl = baseUrl
  try {
    mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 })
    writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    chmodSync(configPath, 0o600)
  } catch (error) {
    throw new EvalConfigError(`could not write the eval config file at ${configPath}: ${errorMessage(error)}`, { cause: error })
  }
  return configPath
}

/** Mask a key for status output: `eval_ab…yz`. */
export function maskApiKey(apiKey: string | undefined): string {
  if (apiKey === undefined || apiKey.length === 0) return '(none)'
  if (apiKey.length <= 8) return `${apiKey.slice(0, 2)}…`
  return `${apiKey.slice(0, 7)}…${apiKey.slice(-4)}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
