/**
 * `@codebam/eval-jev-guardrails`: hosted eval.seanbehan.ca client, CLI, and
 * real tool-call hooks for OpenCode, Hermes Agent, and DeepSeek Harness.
 *
 * @module @codebam/eval-jev-guardrails
 */
export * from './types.js'
export { EvalGuardrailsClient, EvalApiError, EvalTransportError } from './client.js'
export type { EvalGuardrailsClientOptions } from './client.js'
export {
  DEFAULT_BASE_URL,
  DSH_GUARDRAILS_RANGE,
  PACKAGE_VERSION,
} from './version.js'
export {
  EvalConfigError,
  defaultConfigPath,
  maskApiKey,
  readEvalConfigFile,
  resolveEvalConfig,
  writeEvalConfig,
} from './config.js'
export type { ResolveEvalConfigOptions, WriteEvalConfigOptions } from './config.js'
export {
  DEFAULT_FAIL_MODE,
  DEFAULT_REVIEW_MODE,
  guardToolAction,
  isEvalVerdict,
  normalizeFailMode,
  normalizeReviewMode,
  verdictReason,
} from './hook.js'
export type { GuardToolAction, GuardToolActionOptions } from './hook.js'
export {
  OPEN_CODE_TOOL_BEFORE_HOOK,
  createOpenCodeHooks,
  createOpenCodePlugin,
} from './opencode.js'
export type {
  OpenCodeHooks,
  OpenCodePlugin,
  OpenCodePluginInput,
  OpenCodePluginOptions,
  OpenCodeToolInput,
  OpenCodeToolOutput,
} from './opencode.js'
export * from './install/index.js'
export { LOW_CREDIT_THRESHOLD, runDoctor } from './doctor.js'
export type { DoctorCheck, DoctorHarness, DoctorOptions, DoctorReport, DoctorScope } from './doctor.js'
export { openExternalUrl, runCli } from './cli.js'
export type { CliIO } from './cli.js'
