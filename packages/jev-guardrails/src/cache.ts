/**
 * A tiny TTL + LRU response cache.
 *
 * Jev answers are deterministic for identical state + questions + model, so a
 * repeated screen is safe to reuse until the TTL expires or the LRU evicts it.
 *
 * @module @codebam/jev-guardrails/cache
 */
import type { CacheSettings } from './types.js'

interface CacheEntry {
  value: unknown
  expiresAt: number
}

/** Fixed-window in-memory cache; no persistence and no cross-process sharing. */
export class ResponseCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(settings: Partial<CacheSettings> = {}, now: () => number = Date.now) {
    this.ttlMs = Math.max(0, settings.ttlMs ?? 60 * 60 * 1000)
    this.maxEntries = Math.max(1, Math.floor(settings.maxEntries ?? 500))
    this.now = now
  }

  /** Return a live entry, refreshing its LRU position. */
  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    // Refresh insertion order so the most recently used key is last.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value as T
  }

  /** Store one answer and evict the least recently used entry when full. */
  set(key: string, value: unknown): void {
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  /** Drop every entry. */
  clear(): void {
    this.entries.clear()
  }

  /** Current entry count, including entries that have not yet been lazily expired. */
  get size(): number {
    return this.entries.size
  }
}
