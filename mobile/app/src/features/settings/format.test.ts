import { formatCredits, formatDash } from './format';

describe('formatDash', () => {
  it.each([
    [0n, '0 DASH'],
    [100_000_000_000n, '1 DASH'],
    [123_456_789_000n, '1.23456789 DASH'],
    [150_000_000_000n, '1.5 DASH'],
    [1_000n, '0.00000001 DASH'],
    // Below one duff the 8 decimals can't show it: never claim zero.
    [999n, '< 0.00000001 DASH'],
    // Sub-duff remainders are cut, not rounded up.
    [100_000_001_999n, '1.00000001 DASH'],
    [123_456_700_000_000_000n, '1,234,567 DASH'],
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
