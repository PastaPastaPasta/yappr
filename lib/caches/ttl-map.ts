/**
 * A Map whose entries expire `ttlMs` after they were written. Reads past the
 * TTL behave as a miss; expired entries linger until `prune()` or a later
 * `set()` of the same key, so call `prune()` from a sweep if the keyspace is
 * unbounded.
 */
export class TtlMap<K, V> {
  private readonly entries = new Map<K, { value: V; timestamp: number }>()

  constructor(private readonly ttlMs: number) {}

  private fresh(entry: { timestamp: number } | undefined, now = Date.now()): entry is { timestamp: number } {
    return entry !== undefined && now - entry.timestamp < this.ttlMs
  }

  /** The value, or `undefined` when absent or expired. */
  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    return this.fresh(entry) ? entry.value : undefined
  }

  has(key: K): boolean {
    return this.fresh(this.entries.get(key))
  }

  set(key: K, value: V): this {
    this.entries.set(key, { value, timestamp: Date.now() })
    return this
  }

  delete(key: K): boolean {
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  /** Drop every expired entry. */
  prune(): void {
    const now = Date.now()
    this.entries.forEach((entry, key) => {
      if (!this.fresh(entry, now)) this.entries.delete(key)
    })
  }
}
