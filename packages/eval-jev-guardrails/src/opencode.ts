/**
 * Real OpenCode plugin: a `tool.execute.before` hook that asks the hosted
 * eval service about every proposed tool call and throws before execution
 * when the verdict is `block` or `support`.
 *
 * OpenCode auto-loads modules from `.opencode/plugins/` (project) and
 * `~/.config/opencode/plugins/` (global). A module must export a plugin
 * function that returns a hooks object:
 *
 * ```js
 * import { createOpenCodePlugin } from '@codebam/eval-jev-guardrails/opencode'
 * export const EvalJevGuardrailsPlugin = createOpenCodePlugin()
 * ```
 *
 * @module @codebam/eval-jev-guardrails/opencode
 */
import { EvalGuardrailsClient } from './client.js'
import { guardToolAction, normalizeFailMode, normalizeReviewMode } from './hook.js'
import type { EvalFailMode, EvalReviewMode } from './types.js'

/** OpenCode hook input for `tool.execute.before`. */
export interface OpenCodeToolInput {
  tool: string
  sessionID?: string
  callID?: string
  [key: string]: unknown
}

/** OpenCode hook output for `tool.execute.before`; `args` is the proposed tool input. */
export interface OpenCodeToolOutput {
  args?: Record<string, unknown>
  [key: string]: unknown
}

/** The hooks object an OpenCode plugin function returns. */
export interface OpenCodeHooks {
  'tool.execute.before': (input: OpenCodeToolInput, output: OpenCodeToolOutput) => Promise<void>
  [key: string]: unknown
}

/** Context OpenCode passes to a plugin function. */
export interface OpenCodePluginInput {
  directory?: string
  worktree?: string
  project?: unknown
  client?: unknown
  $?: unknown
  [key: string]: unknown
}

/** A plugin function as expected by OpenCode's plugin loader. */
export type OpenCodePlugin = (input?: OpenCodePluginInput) => OpenCodeHooks

/**
 * The value returned by {@link createOpenCodePlugin}: a plugin function whose
 * hook properties are also available directly, so both
 * `createOpenCodePlugin().tool['tool.execute.before']` (plugin loader style)
 * and `createOpenCodePlugin()['tool.execute.before']` (direct hook style)
 * work.
 */
export type OpenCodePluginFactory = OpenCodePlugin & OpenCodeHooks

/** Options for {@link createOpenCodeHooks} / {@link createOpenCodePlugin}. */
export interface OpenCodePluginOptions {
  /** Injectable client (tests). */
  client?: EvalGuardrailsClient
  /** Explicit key; otherwise `EVAL_API_KEY` then the config file. */
  apiKey?: string
  /** Explicit base URL; otherwise `EVAL_BASE_URL` then the config file. */
  baseUrl?: string
  /** Config file override; otherwise `EVAL_CONFIG_PATH` or `~/.config/eval-jev/config.json`. */
  configPath?: string
  /** Request timeout in milliseconds. */
  timeoutMs?: number
  /** `deny` (default) blocks a `review` verdict; `allow` lets it run. */
  reviewMode?: EvalReviewMode
  /** `open` (default), `review`, or `closed`. */
  failMode?: EvalFailMode
  /** Workspace value sent to the service. Defaults to the plugin context directory or `process.cwd()`. */
  workspace?: string
  /** Exact tool names to skip, e.g. `['Read', 'List']`. */
  skipTools?: string[]
  /** Environment source for `EVAL_*` defaults. */
  env?: NodeJS.ProcessEnv
  /** Coarse logger hook; defaults to warning on stderr. */
  logger?: (message: string) => void
}

/** The OpenCode hook name this package installs. */
export const OPEN_CODE_TOOL_BEFORE_HOOK = 'tool.execute.before'

/** Build the OpenCode hooks object directly (used by tests and the plugin wrapper). */
export function createOpenCodeHooks(options: OpenCodePluginOptions = {}): OpenCodeHooks {
  const env = options.env ?? process.env
  const reviewMode = normalizeReviewMode(options.reviewMode ?? env.EVAL_REVIEW_MODE)
  const failMode = normalizeFailMode(options.failMode ?? env.EVAL_FAIL_MODE)
  const skipTools = new Set([
    ...(options.skipTools ?? []),
    ...parseList(env.EVAL_SKIP_TOOLS),
  ])
  const logger = options.logger ?? ((message: string) => console.warn(message))
  let client = options.client

  const getClient = (): EvalGuardrailsClient => {
    if (client === undefined) {
      client = new EvalGuardrailsClient({
        env,
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
        ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      })
    }
    return client
  }

  const before = async (input: OpenCodeToolInput, output: OpenCodeToolOutput): Promise<void> => {
    const tool = typeof input?.tool === 'string' && input.tool.length > 0 ? input.tool : 'unknown'
    if (skipTools.has(tool)) return
    const args = isRecord(output?.args) ? output.args : {}
    const outcome = await guardToolAction(
      getClient(),
      {
        tool,
        args,
        workspace: options.workspace ?? process.cwd(),
        ...(typeof input?.sessionID === 'string' ? { sessionID: input.sessionID } : {}),
        ...(typeof input?.callID === 'string' ? { callID: input.callID } : {}),
      },
      { reviewMode, failMode },
    )

    if (outcome.decision === 'block') {
      logger(`[eval-jev-guardrails] blocked ${tool}: ${outcome.reason ?? 'unsafe tool call'}`)
      throw new Error(outcome.reason ?? `Blocked by eval guardrails: the tool call \`${tool}\` was flagged as unsafe.`)
    }
    if (outcome.degraded) {
      logger(`[eval-jev-guardrails] allowed ${tool} without a verdict (fail mode ${failMode}): ${outcome.error ?? 'unknown error'}`)
    } else if (outcome.verdict?.action === 'review' && reviewMode === 'allow') {
      logger(`[eval-jev-guardrails] review allowed ${tool}: ${outcome.verdict.reason ?? 'flagged for review'}`)
    }
  }

  return { [OPEN_CODE_TOOL_BEFORE_HOOK]: before }
}

/**
 * Create a real OpenCode plugin.
 *
 * OpenCode calls the returned function with its plugin input and registers
 * every hook on the returned object. The workspace is taken from
 * `input.worktree`/`input.directory` when available.
 */
export function createOpenCodePlugin(options: OpenCodePluginOptions = {}): OpenCodePluginFactory {
  const plugin = ((input?: OpenCodePluginInput): OpenCodeHooks => {
    const workspace =
      options.workspace ??
      firstString(input?.worktree, input?.directory) ??
      process.cwd()
    return createOpenCodeHooks({ ...options, workspace })
  }) as OpenCodePluginFactory
  return Object.assign(plugin, createOpenCodeHooks(options))
}

function parseList(value: string | undefined): string[] {
  if (value === undefined) return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}
