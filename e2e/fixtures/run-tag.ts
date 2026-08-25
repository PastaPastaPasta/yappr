import { randomUUID } from 'node:crypto'

/**
 * Every document a run creates carries a unique tag, so assertions only ever
 * look at content this run produced. The test contracts accumulate state (there
 * is no per-test cleanup — deletes cost credits and flake), and a deterministic
 * tag would collide with previous runs, so the random part is mandatory.
 */
export function uniqueTag(identityIndex: number): string {
  return `e2e-${identityIndex}-${randomUUID().replace(/-/g, '').slice(0, 12)}`
}
