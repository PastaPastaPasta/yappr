import { formatCredits, formatDash } from './format';

describe('formatDash', () => {
  it.each([
    [0n, '0 DASH'],
    [100_000_000_000n, '1 DASH'],
    // The audit's example: 4 decimals, not a wallet's 8 (agent-isms #15).
    [25_674_582_414n, '0.2567 DASH'],
    [123_456_789_000n, '1.2345 DASH'],
    [150_000_000_000n, '1.5 DASH'],
    [10_000_000n, '0.0001 DASH'],
    // Below the smallest step the 4 decimals can't show it: never claim zero.
    [9_999_999n, '< 0.0001 DASH'],
    [1n, '< 0.0001 DASH'],
    // Remainders are cut, not rounded up.
    [99_999_999_999n, '0.9999 DASH'],
    [123_456_700_000_000_000n, '1,234,567 DASH'],
    [-25_674_582_414n, '-0.2567 DASH'],
  ])('%s credits → %s', (credits, text) => {
    expect(formatDash(credits)).toBe(text);
  });
});

describe('formatCredits', () => {
  it('groups thousands', () => {
    expect(formatCredits(0n)).toBe('0');
    expect(formatCredits(123_456_789_000n)).toBe('123,456,789,000');
    expect(formatCredits(-1_500n)).toBe('-1,500');
  });
});
