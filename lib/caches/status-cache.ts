/**
 * A viewer-scoped boolean relation ("does viewer X follow/block Y") with a
 * TTL, shared between the per-row hooks and the batch enrichers that
 * pre-populate it before those hooks mount.
 */
export class StatusCache {
  private entries = new Map<string, { value: boolean; timestamp: number }>()

  constructor(private readonly ttlMs: number) {}

  key(viewerId: string, subjectId: string): string {
    return `${viewerId}:${subjectId}`
  }

  /** The cached value, or `null` when absent or expired. */
  get(viewerId: string, subjectId: string): boolean | null {
    const cached = this.entries.get(this.key(viewerId, subjectId))
    if (cached && Date.now() - cached.timestamp < this.ttlMs) return cached.value
    return null
  }

  set(viewerId: string, subjectId: string, value: boolean): void {
    this.entries.set(this.key(viewerId, subjectId), { value, timestamp: Date.now() })
  }

  delete(viewerId: string, subjectId: string): void {
    this.entries.delete(this.key(viewerId, subjectId))
  }

  /** Pre-populate from a batch lookup so rows mounting next need no query. */
  seed(viewerId: string, statuses: Map<string, boolean>): void {
    if (!viewerId) return
    const timestamp = Date.now()
    statuses.forEach((value, subjectId) => {
      this.entries.set(this.key(viewerId, subjectId), { value, timestamp })
    })
  }
}
