import * as web from '@/lib/compose/limits';

import {
  characterCount,
  charactersLeft,
  contentOverage,
  counterLabel,
  counterTone,
  hasVisibleContent,
  isOverContentLimit,
  overflowOffset,
  postedOverflowOffset,
  utf8ByteCount,
} from './limits';

/** Shared fixtures (PRD COMP-02): emoji, ZWJ sequences, CJK, Arabic, combining marks, invisibles. */
const FIXTURES = [
  '',
  'hello',
  'Hello 👋 world',
  '👨‍👩‍👧‍👦',
  '🏳️‍🌈 flag',
  '日本語のテキスト',
  'مرحبا بالعالم',
  'é café',
  ' \n\t ',
  '​‍﻿',
  '­',
  'a​b',
  '#tag $DASH @alice https://yap.pr',
  'x'.repeat(1001),
  '😀'.repeat(600),
];

describe('content limits mirror lib/compose/limits.ts', () => {
  it.each(FIXTURES.map((text) => [JSON.stringify(text).slice(0, 40), text]))('%s', (_label, text) => {
    expect(characterCount(text)).toBe(web.characterCount(text));
    expect(utf8ByteCount(text)).toBe(web.utf8ByteCount(text));
    expect(hasVisibleContent(text)).toBe(web.hasVisibleContent(text));
    for (const limits of [
      { chars: 500, bytes: null },
      { chars: 1000, bytes: 2000 },
    ]) {
      expect(contentOverage(text, limits)).toEqual(
        web.contentOverage(text, 0, { maxLength: limits.chars, maxBytes: limits.bytes }),
      );
    }
  });
});

describe('overflowOffset', () => {
  it('is null within the limits', () => {
    expect(overflowOffset('hello', { chars: 5, bytes: null })).toBeNull();
  });

  it('starts at the first code point past the character limit, never mid-surrogate', () => {
    expect(overflowOffset('abcdef', { chars: 5, bytes: null })).toBe(5);
    // Each emoji is two UTF-16 units.
    expect(overflowOffset('😀😀😀', { chars: 2, bytes: null })).toBe(4);
  });

  it('starts where the byte limit binds first', () => {
    // 4 bytes per emoji: the third crosses 10 bytes.
    expect(overflowOffset('😀😀😀', { chars: 100, bytes: 10 })).toBe(4);
  });
});

describe('postedOverflowOffset', () => {
  const limits = { chars: 5, bytes: null };

  it('ignores the whitespace that posting trims (PRD COMP-02)', () => {
    expect(postedOverflowOffset('abcde\n\n', limits)).toBeNull();
    expect(postedOverflowOffset('  abcde', limits)).toBeNull();
  });

  it('lands the highlight on the raw text, past the leading whitespace', () => {
    expect(postedOverflowOffset('  abcdefg ', limits)).toBe(7);
  });
});

describe('the counter', () => {
  const limits = { chars: 100, bytes: null };

  it('is gray, amber at 50 or fewer left, red when over', () => {
    expect(counterTone('x'.repeat(49), limits)).toBe('secondary');
    expect(counterTone('x'.repeat(50), limits)).toBe('warning');
    expect(counterTone('x'.repeat(100), limits)).toBe('warning');
    expect(counterTone('x'.repeat(101), limits)).toBe('error');
  });

  it('is red when only the bytes are over', () => {
    expect(counterTone('😀'.repeat(10), { chars: 100, bytes: 20 })).toBe('error');
  });

  it('reads "{n} characters left", or "Too long by {n}" (#19)', () => {
    expect(counterLabel('x'.repeat(10), limits)).toBe('90 characters left');
    expect(counterLabel('x'.repeat(99), limits)).toBe('1 character left');
    expect(counterLabel('x'.repeat(100), limits)).toBe('0 characters left');
    expect(counterLabel('x'.repeat(103), limits)).toBe('Too long by 3');
  });

  it('counts the bytes too, never bytes in its words (#19, D-L2i-001)', () => {
    // 501 emoji are 2004 bytes: the old counter read "501 / 1000" while Post was off.
    expect(counterLabel('😀'.repeat(501), { chars: 1000, bytes: 2000 })).toBe('Too long by 4');
    expect(counterLabel('😀'.repeat(500), { chars: 1000, bytes: 2000 })).toBe('0 characters left');
    expect(counterTone('😀'.repeat(490), { chars: 1000, bytes: 2000 })).toBe('warning');
  });
});

/** The limits every contract the engine reports declares (`capabilities.contentLimits`): v2, and v10's characters and bytes. */
const ENGINE_LIMITS = [
  { chars: 500, bytes: null },
  { chars: 1000, bytes: 2000 },
];

/** lib's verdict (`lib/compose/limits.ts`), the one Post and the engine's publish go by. */
const libOver = (text: string, limits: { chars: number; bytes: number | null }) => {
  const { charactersOver, bytesOver } = web.contentOverage(text, 0, { maxLength: limits.chars, maxBytes: limits.bytes });
  return charactersOver > 0 || bytesOver > 0;
};

describe('charactersLeft: 0 is exactly the longest post lib takes (#19)', () => {
  /** Texts at the very edge of each limit: plain, emoji, a ZWJ family, CJK, Arabic, and mixes. */
  const AT_LIMIT: [string, string, { chars: number; bytes: number | null }][] = [
    ['ASCII at 500', 'a'.repeat(500), ENGINE_LIMITS[0]],
    ['ASCII at 1000', 'a'.repeat(1000), ENGINE_LIMITS[1]],
    ['emoji at 2000 bytes', '😀'.repeat(500), ENGINE_LIMITS[1]],
    ['emoji at 500 characters', '😀'.repeat(500), ENGINE_LIMITS[0]],
    // 👨‍👩‍👧‍👦 is 7 code points and 25 bytes: 80 of them are 560 characters and 2000 bytes.
    ['ZWJ families at 2000 bytes', '👨‍👩‍👧‍👦'.repeat(80), ENGINE_LIMITS[1]],
    ['CJK at 2000 bytes', `${'日'.repeat(666)}ab`, ENGINE_LIMITS[1]],
    ['Arabic at both limits', 'م'.repeat(1000), ENGINE_LIMITS[1]],
    ['Arabic at 500', 'م'.repeat(500), ENGINE_LIMITS[0]],
    ['mixed at 2000 bytes', `${'é'.repeat(200)}${'😀'.repeat(300)}${'a'.repeat(400)}`, ENGINE_LIMITS[1]],
  ];

  it.each(AT_LIMIT)('%s', (_label, text, limits) => {
    expect(libOver(text, limits)).toBe(false);
    expect(charactersLeft(text, limits)).toBe(0);
    // Not one more character fits, of any kind.
    for (const more of ['a', 'é', '日', 'م', '😀', '👨‍👩‍👧‍👦']) {
      expect(libOver(text + more, limits)).toBe(true);
      expect(charactersLeft(text + more, limits)).toBeLessThan(0);
    }
  });

  const SAMPLES = [
    ...FIXTURES,
    '😀'.repeat(499),
    '👨‍👩‍👧‍👦 '.repeat(70),
    '日本語'.repeat(220),
    'مرحبا '.repeat(160),
    `${'a'.repeat(995)}😀`,
    `${'a'.repeat(997)}😀`,
  ];

  it.each(SAMPLES.map((text) => [JSON.stringify(text).slice(0, 40), text]))('agrees with lib on %s', (_label, text) => {
    for (const limits of ENGINE_LIMITS) {
      const left = charactersLeft(text, limits);
      expect(left < 0).toBe(libOver(text, limits));
      expect(left < 0).toBe(isOverContentLimit(text, limits));
      if (left >= 0) {
        // Exactly `left` more plain characters fit, and no more.
        expect(libOver(text + 'a'.repeat(left), limits)).toBe(false);
        expect(libOver(text + 'a'.repeat(left + 1), limits)).toBe(true);
      }
    }
  });
});
