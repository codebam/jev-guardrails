/**
 * @codebam/dsh-jev-guardrails
 *
 * A DeepSeek Harness plugin that uses `@codebam/jev-guardrails` to screen:
 *
 * - incoming human prompts (`agent/pre-step`),
 * - proposed tool calls before dispatch (`tools/pre-execute`),
 * - tool results before they enter model context (`tools/post-execute`),
 * - completed assistant responses (`session/event` + `agent/turn-stopping`).
 *
 * The plugin contains no Jev policy of its own: it translates Cordis
 * configuration and harness decisions into library calls. See the library
 * README for the batteries, routing rules, and fail modes.
 *
 * @module @codebam/dsh-jev-guardrails
 */
import { createGuardrails } from '@codebam/jev-guardrails'
import { Config, libraryOptions, normalizeConfig } from './src/config.mjs'
import { createRuntime } from './src/runtime.mjs'

/** Cordis plugin name. */
export const name = 'dsh-jev-guardrails'

/**
 * `tools` must exist before the policy pipeline can be extended. Input and
 * output events are dispatched on the same root context, so no further
 * service dependency is required.
 */
export const inject = ['tools']

export { Config }

/**
 * Mount the guardrails plugin.
 *
 * Configuration or client failures disable the plugin with a warning instead
 * of failing the profile boot: a missing API key should not make the harness
 * unusable.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning Cordis context.
 * @param {object} [rawConfig] - plugin row configuration, as resolved by the loader.
 * @returns {ReturnType<import('./src/runtime.mjs').createRuntime>|undefined}
 */
export function apply(ctx, rawConfig = {}) {
  let config
  try {
    config = normalizeConfig(rawConfig)
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-jev-guardrails] disabled: ${String(error?.message ?? error)}`)
    return undefined
  }

  let guardrails
  try {
    guardrails = createGuardrails(libraryOptions(config))
  } catch (error) {
    const keyName = config.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'TYPESAFE_API_KEY'
    ctx.logger?.warn?.(
      `[dsh-jev-guardrails] disabled: ${String(error?.message ?? error)}. Set ${keyName} or set apiKey in the plugin config.`,
    )
    return undefined
  }

  const runtime = createRuntime({ guardrails, config, logger: ctx.logger })
  ctx.effect(() => runtime.dispose, 'dsh-jev-guardrails: remove policy listeners')
  runtime.install(ctx)
  if (config.log === 'verbose') {
    ctx.logger?.info?.(
      `[dsh-jev-guardrails] mounted provider=${config.provider} model=${config.model} input=${config.input} actions=${config.actions} observations=${config.observations} outputs=${config.outputs}`,
    )
  }
  return runtime
}

export default { name, inject, Config, apply }
