/**
 * Small pure helpers shared by the client, batteries, and plugin.
 *
 * @module @codebam/jev-guardrails/util
 */

/** True for arrays and non-null objects. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deterministic JSON for cache keys and request state.
 *
 * Object keys are sorted recursively and `undefined` values are dropped, so
 * two structurally equal states produce the same string regardless of key
 * insertion order.
 */
export function stableStringify(value: unknown): string {
  const rendered = JSON.stringify(sortValue(value))
  return rendered === undefined ? 'undefined' : rendered
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const entry = value[key]
      if (entry !== undefined) out[key] = sortValue(entry)
    }
    return out
  }
  return value
}

/**
 * Middle-truncate a string so both the beginning and the end (usually the
 * destination or final error) survive.
 */
export function truncateMiddle(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean; omitted: number } {
  if (!Number.isFinite(maxChars) || maxChars < 16 || text.length <= maxChars) {
    return { text, truncated: false, omitted: 0 }
  }
  const markerBudget = 64
  const keep = Math.max(0, maxChars - markerBudget)
  const head = Math.ceil(keep * 0.6)
  const tail = keep - head
  const omitted = text.length - head - tail
  const marker = `\n...[truncated ${omitted} characters]...\n`
  return { text: `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`, truncated: true, omitted }
}

/** Render a probability as a compact percentage. */
export function formatProbability(probability: number): string {
  if (!Number.isFinite(probability)) return 'n/a'
  return `${Math.round(probability * 100)}%`
}

/** Render a probability as a two-decimal number in a parenthetical. */
export function formatP(probability: number): string {
  if (!Number.isFinite(probability)) return 'p=n/a'
  return `p=${probability.toFixed(2)}`
}

/**
 * Flatten the text found in common content shapes.
 *
 * Handles plain strings, arrays, `{ type: 'text', text }` blocks,
 * `{ content: [...] }` wrappers, `{ message: ... }` wrappers, and falls back
 * to deterministic JSON for anything else. The dsh plugin relies on this for
 * message and tool-result content.
 */
export function contentToText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(contentToText).filter((part) => part.length > 0).join('\n')
  if (isRecord(value)) {
    if (typeof value.text === 'string' && (value.type === 'text' || value.type === 'reasoning' || value.type === undefined)) {
      return value.text
    }
    if (value.content !== undefined) return contentToText(value.content)
    if (value.message !== undefined) return contentToText(value.message)
    if (typeof value.result === 'string') return value.result
    return stableStringify(value)
  }
  return String(value)
}

/** Clamp a number into a range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Return the entries of a record sorted by descending numeric value. */
export function topEntries(
  values: Record<string, number>,
): Array<[string, number]> {
  return Object.entries(values).sort((a, b) => b[1] - a[1])
}
