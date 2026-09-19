/**
 * Plugin-sourced conversation messages used for warnings, block notices, and
 * output steering.
 *
 * dsh messages are immutable and identified; always build them through
 * `createUserMessage` so they carry a stable id and an honest `plugin` source.
 *
 * @module @codebam/dsh-jev-guardrails/messages
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const SUMMARY_MAX = 120

/**
 * Create one plugin-sourced notice as a user-role message.
 * @param {string} text - model-facing text.
 * @param {string} summary - one-line account shown on a collapsed row.
 */
export function makeNotice(text, summary) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-jev-guardrails',
      form: 'notice',
      summary: String(summary).slice(0, SUMMARY_MAX),
    },
  })
}

/** The session workspace root, when this execution has an agent. */
export function sessionWorkspace(agent) {
  return agent?.session?.header?.cwd
}

/** Flatten dsh result content blocks to text for a Jev check. */
export function blocksToText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        if (typeof block === 'string') return block
        if (block === null || typeof block !== 'object') return String(block)
        if (block.type === 'text' && typeof block.text === 'string') return block.text
        if (block.type === 'tool-result' && typeof block.content !== 'undefined') return blocksToText(block.content)
        if (typeof block.text === 'string') return block.text
        return ''
      })
      .filter((part) => part.length > 0)
      .join('\n')
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.content !== 'undefined') return blocksToText(value.content)
    if (typeof value.message !== 'undefined') return blocksToText(value.message)
  }
  return ''
}
