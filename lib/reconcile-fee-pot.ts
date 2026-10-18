import type { FeePotState } from '@/lib/services/moderation-service'

/** Only history at or beyond the proved payout epoch includes that payout. */
export async function reconcileFeePot(
  read: () => Promise<FeePotState | null>,
  confirmedEpoch: number,
  pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 1500)),
): Promise<FeePotState | null> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const pot = await read()
      if (pot?.lastClaimEpoch != null &&
        pot.lastClaimEpoch >= confirmedEpoch) return pot
    } catch {
      // A transient failure after confirmation does not make another claim safe.
    }
    if (attempt < 3) await pause()
  }
  return null
}
