/**
 * The DeepSeek Harness runtime for `dsh-jev-guardrails`.
 *
 * Four interception points, each optional:
 *
 * - `agent/pre-step` (input): screen a human prompt before the model sees it;
 * - `tools/pre-execute` (action): score a proposed tool call before dispatch;
 * - `tools/post-execute` (observation): screen tool output for injection and
 *   other untrusted-content hazards before it becomes model context;
 * - `session/event` + `agent/turn-stopping` (output): screen the final
 *   assistant message and optionally steer a corrected response.
 *
 * The runtime is deliberately thin: every decision comes from the library, and
 * every runtime failure is contained so a guardrail can never take down a
 * turn.
 *
 * @module @codebam/dsh-jev-guardrails/runtime
 */
import {
  correctionNotice,
  describeVerdict,
  guardrailNotice,
  looksLikeInjection,
  modelFacingReason,
} from '@codebam/jev-guardrails'
import { blocksToText, makeNotice, sessionWorkspace } from './messages.mjs'

/**
 * Create the runtime. `install(ctx)` registers listeners and returns a dispose
 * function; the handlers are exposed for direct unit testing.
 *
 * @param {{
 *   guardrails: import('@codebam/jev-guardrails').JevGuardrails,
 *   config: ReturnType<import('./config.mjs').normalizeConfig>,
 *   logger?: { debug?: Function, info?: Function, warn?: Function, error?: Function },
 * }} options
 */
export function createRuntime({ guardrails, config, logger }) {
  const skipTools = new Set(config.skipTools.map((name) => name.toLowerCase()))
  const guardTools = config.guardTools === undefined ? undefined : new Set(config.guardTools.map((name) => name.toLowerCase()))
  let assistantBySession = new WeakMap()
  let steeredTurns = new WeakMap()
  const disposers = []
  let disposed = false

  const log = (level, message) => {
    if (disposed) return
    const method = typeof logger?.[level] === 'function' ? logger[level] : undefined
    if (method !== undefined) {
      method.call(logger, `[dsh-jev-guardrails] ${message}`)
      return
    }
    if (level === 'error') console.error(`[dsh-jev-guardrails] ${message}`)
    else if (level === 'warn') console.warn(`[dsh-jev-guardrails] ${message}`)
    else if (level === 'info' && config.log === 'verbose') console.info(`[dsh-jev-guardrails] ${message}`)
  }

  const logVerdict = (subject, verdict) => {
    if (config.log === 'off') return
    if (verdict.action === 'allow' && config.log !== 'verbose') return
    const level = verdict.degraded || verdict.action === 'block' || verdict.action === 'support' ? 'warn' : 'info'
    log(level, `${subject}: ${describeVerdict(verdict)}`)
  }

  const shouldScreenTool = (name) => {
    const normalized = String(name).toLowerCase()
    if (skipTools.has(normalized)) return false
    if (guardTools !== undefined && !guardTools.has(normalized)) return false
    return true
  }

  /** Screen a claimed human prompt. */
  async function onPreStep({ agent, messages, signal }, next) {
    if (!Array.isArray(messages) || messages.length === 0) return next()
    if (signal?.aborted) return next()
    const humanMessages = messages.filter((message) => message?.source?.kind === 'user' || message?.source === undefined)
    if (humanMessages.length === 0) return next()
    const text = humanMessages.map((message) => blocksToText(message.content)).join('\n').trim()
    if (text.length === 0) return next()

    const verdict = await guardrails.screenInput(text, { signal })
    logVerdict('prompt', verdict)
    if (verdict.action === 'allow' || config.input === 'observe') return next()

    if (config.input === 'warn' || verdict.action === 'review') {
      const downstream = await next()
      if (downstream.kind !== 'enter') return downstream
      return {
        ...downstream,
        messages: [...downstream.messages, makeNotice(guardrailNotice(verdict), `input ${verdict.action}`)],
      }
    }

    if (config.inputBlockStyle === 'notice') {
      return {
        kind: 'enter',
        messages: [
          makeNotice(
            `[Jev guardrails: ${verdict.action}] The user's message was blocked before reaching you. ${modelFacingReason(verdict)}`,
            `input blocked: ${verdict.action}`,
          ),
        ],
      }
    }
    return { kind: 'reject' }
  }

  /** Screen a proposed tool call before dispatch. */
  async function onPreToolUse(exec, next) {
    if (!shouldScreenTool(exec.name)) return next()
    if (exec.signal?.aborted) return next()
    const verdict = await guardrails.assessAction(
      {
        tool: exec.name,
        arguments: exec.arguments,
        workspace: sessionWorkspace(exec.agent),
      },
      { signal: exec.signal },
    )
    logVerdict(`tool call ${exec.name}`, verdict)
    if (config.actions === 'observe' || verdict.action === 'allow') return next()

    const mapped = verdict.action === 'review' ? config.onActionReview : config.onActionBlock
    if (mapped === 'allow') return next()
    const reason = modelFacingReason(verdict)
    if (mapped === 'ask') return { kind: 'ask', reason }
    return { kind: 'deny', reason }
  }

  /** Screen tool output before it enters model context. */
  async function onPostToolUse(exec, result, next) {
    if (!shouldScreenTool(exec.name)) return next()
    const text = blocksToText(result?.content)
    if (text.trim().length === 0) return next()
    if (config.observations === 'suspicious' && !looksLikeInjection(text).suspicious) return next()

    const verdict = await guardrails.screenObservation(text, { signal: exec.signal })
    logVerdict(`tool result ${exec.name}`, verdict)
    const downstream = await next()
    if (config.observations === 'observe' || verdict.action === 'allow') return downstream

    const notice = makeNotice(guardrailNotice(verdict), `tool result ${verdict.action}`)
    if (verdict.action === 'review') return appendContext(downstream, notice)

    return {
      kind: 'block',
      feedback: [{ type: 'text', text: modelFacingReason(verdict) }],
      ...(contextsOf(downstream).length > 0 ? { additionalContexts: contextsOf(downstream) } : {}),
    }
  }

  /** Remember the latest completed assistant message of each turn. */
  function onSessionEvent(session, event) {
    if (session === undefined || event === undefined) return
    if (event.type === 'turn/end') {
      assistantBySession.delete(session)
      return
    }
    if (event.type !== 'assistant/message') return
    const turn = event.data?.turn
    if (typeof turn !== 'number') return
    assistantBySession.set(session, {
      turn,
      text: blocksToText(event.data?.message?.content),
    })
  }

  /** Optionally screen the final assistant message and steer a correction. */
  async function onTurnStopping({ agent, turn, signal }) {
    const session = agent?.session
    if (session === undefined || signal?.aborted) return
    const record = assistantBySession.get(session)
    if (record === undefined || record.turn !== turn || record.text.trim().length === 0) return
    if ((steeredTurns.get(session) ?? -1) >= turn) return

    const verdict = await guardrails.screenOutput(record.text, { signal })
    logVerdict('response', verdict)
    if (config.outputs !== 'steer' || verdict.action === 'allow') return

    // One correction attempt per turn; a second flagged response is logged but
    // not steered again, so a blocked model cannot loop the guardrail.
    steeredTurns.set(session, turn)
    try {
      agent.steer(makeNotice(correctionNotice(verdict), `response ${verdict.action}`))
    } catch (error) {
      log('warn', `could not steer a corrected response: ${String(error)}`)
    }
  }

  /** Register the configured listeners on a Cordis context. */
  function install(ctx) {
    if (config.input !== 'off') {
      disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
        try {
          return await onPreStep(payload, next)
        } catch (error) {
          log('warn', `input screen failed open: ${String(error)}`)
          return next()
        }
      }))
    }
    if (config.actions !== 'off') {
      disposers.push(ctx.on('tools/pre-execute', async (exec, next) => {
        try {
          return await onPreToolUse(exec, next)
        } catch (error) {
          log('warn', `tool screen failed open: ${String(error)}`)
          return next()
        }
      }))
    }
    if (config.observations !== 'off') {
      disposers.push(ctx.on('tools/post-execute', async (exec, result, next) => {
        try {
          return await onPostToolUse(exec, result, next)
        } catch (error) {
          log('warn', `tool-result screen failed open: ${String(error)}`)
          return next()
        }
      }))
    }
    if (config.outputs !== 'off') {
      disposers.push(ctx.on('session/event', onSessionEvent))
      disposers.push(ctx.on('agent/turn-stopping', async (payload) => {
        try {
          await onTurnStopping(payload)
        } catch (error) {
          log('warn', `response screen failed open: ${String(error)}`)
        }
      }))
    }
    return dispose
  }

  function dispose() {
    if (disposed) return
    disposed = true
    assistantBySession = new WeakMap()
    steeredTurns = new WeakMap()
    while (disposers.length > 0) {
      const disposeListener = disposers.pop()
      try {
        disposeListener?.()
      } catch {
        // Disposal is best-effort; a stale listener is harmless.
      }
    }
  }

  return {
    install,
    dispose,
    handlers: { onPreStep, onPreToolUse, onPostToolUse, onSessionEvent, onTurnStopping },
  }
}

function appendContext(decision, context) {
  const contexts = [context, ...contextsOf(decision)]
  if (decision.kind === 'accept' || decision.kind === 'block') {
    return { ...decision, additionalContexts: contexts }
  }
  return decision
}

function contextsOf(decision) {
  if (decision?.kind === 'accept' || decision?.kind === 'block') return decision.additionalContexts ?? []
  return []
}
