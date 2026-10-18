import type { FeePotState } from '@/lib/services/moderation-service'

/** A confirmed payout must advance claim history; lagging balance reads cannot undo it. */
export async function reconcileFeePot(
  read: () => Promise<FeePotState | null>,
  previousEpoch: number | null,
  pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 1500)),
): Promise<FeePotState | null> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const pot = await read()
      if (pot?.lastClaimEpoch != null &&
        (previousEpoch === null || pot.lastClaimEpoch > previousEpoch)) return pot
    } catch {
      // A transient failure after confirmation does not make another claim safe.
    }
    if (attempt < 3) await pause()
  }
  return null
}
