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

/** "March 4, 2026". */
export function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
