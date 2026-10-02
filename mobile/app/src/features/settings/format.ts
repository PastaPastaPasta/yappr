/** 1 DASH = 10^8 duffs = 10^11 credits on Dash Platform. */
export const CREDITS_PER_DASH = 100_000_000_000n;
/** 1 duff = 1000 credits: the smallest step the 8-decimal DASH value shows. */
const CREDITS_PER_DUFF = 1000n;

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * Credits as DASH with up to 8 decimals, trailing zeros dropped (PRD SET-02):
 * 123_456_789_000n → "1.23456789 DASH". Below one duff it reads "< 0.00000001 DASH".
 */
export function formatDash(credits: bigint): string {
  if (credits < 0n) return `-${formatDash(-credits)}`;
  if (credits > 0n && credits < CREDITS_PER_DUFF) return '< 0.00000001 DASH';
  const duffs = credits / CREDITS_PER_DUFF;
  const whole = duffs / 100_000_000n;
  const fraction = (duffs % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${group(whole.toString())}${fraction ? `.${fraction}` : ''} DASH`;
}

/** The raw credits, grouped: "123,456,789,000". */
export function formatCredits(credits: bigint): string {
  return credits < 0n ? `-${group((-credits).toString())}` : group(credits.toString());
}

/** "March 4, 2026". */
export function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
