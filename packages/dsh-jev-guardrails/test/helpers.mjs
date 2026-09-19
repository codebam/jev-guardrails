/** Shared plugin test helpers. */

export function verdict(overrides = {}) {
  return {
    side: 'input',
    kind: 'prompt',
    action: 'allow',
    source: 'jev',
    hazards: {},
    reasons: [],
    reason: 'test verdict',
    cached: false,
    degraded: false,
    ...overrides,
  }
}

/**
 * A minimal Cordis context for handler tests.
 * @returns {any}
 */
export function createCtx() {
  const listeners = new Map()
  return {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
        return index >= 0
      }
    },
    effect(setup) {
      return setup()
    },
    listeners,
    count(name) {
      return (listeners.get(name) ?? []).length
    },
  }
}

/** Invoke every listener for one event in order. */
export async function emit(ctx, name, ...args) {
  const listeners = ctx.listeners.get(name) ?? []
  for (const listener of listeners) await listener(...args)
}

/** Build a tool execution payload. */
export function toolExec(overrides = {}) {
  return {
    name: 'Bash',
    arguments: { command: 'python train.py' },
    signal: new AbortController().signal,
    ...overrides,
  }
}

/** Build a user message containing text. */
export function userMessage(text, source = { kind: 'user' }) {
  return { id: 'm1', role: 'user', source, content: [{ type: 'text', text }] }
}
