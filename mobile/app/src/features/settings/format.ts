/** 1 DASH = 10^8 duffs = 10^11 credits on Dash Platform. */
export const CREDITS_PER_DASH = 100_000_000_000n;
/** The smallest step the 4-decimal DASH value shows: 0.0001 DASH. */
const CREDITS_PER_STEP = CREDITS_PER_DASH / 10_000n;

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * Credits as DASH with up to 4 decimals, cut (never rounded up) and trailing
 * zeros dropped (PRD SET-02): 25_674_582_414n → "0.2567 DASH". Below the
 * smallest step it reads "< 0.0001 DASH", never zero.
 */
export function formatDash(credits: bigint): string {
  if (credits < 0n) return `-${formatDash(-credits)}`;
  if (credits > 0n && credits < CREDITS_PER_STEP) return '< 0.0001 DASH';
  const steps = credits / CREDITS_PER_STEP;
  const whole = steps / 10_000n;
  const fraction = (steps % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
  return `${group(whole.toString())}${fraction ? `.${fraction}` : ''} DASH`;
}

/** The reference price amounts are shown at: $60 a DASH (1M credits ≈ 0.06¢). */
const CENTS_PER_DASH = 6000;

/** Credits in cents at the reference price: "about 600¢", "about 4.2¢", "under 0.1¢". */
export function formatCents(credits: bigint): string {
  const cents = (Number(credits) / Number(CREDITS_PER_DASH)) * CENTS_PER_DASH;
  if (cents === 0) return '0¢';
  if (cents < 0.1) return 'under 0.1¢';
  if (cents >= 100) return `about ${group(Math.round(cents).toString())}¢`;
  if (cents >= 10) return `about ${Math.round(cents)}¢`;
  return `about ${cents.toFixed(1)}¢`;
}

/** "March 4, 2026". */
export function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
