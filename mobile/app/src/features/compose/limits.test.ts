import * as web from '@/lib/compose/limits';

import {
  characterCount,
  contentOverage,
  counterLabel,
  counterTone,
  hasVisibleContent,
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

  it('reads "{current} of {limit} characters", with the overage', () => {
    expect(counterLabel('x'.repeat(10), limits)).toBe('10 of 100 characters');
    expect(counterLabel('x'.repeat(103), limits)).toBe('103 of 100 characters, 3 over limit');
  });
});
