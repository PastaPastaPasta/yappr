import {
  blockLineCaps,
  directionBlocks,
  directionRuns,
  directionStyle,
  firstStrongDirection,
  lineDirections,
} from './direction';

const ARABIC = 'مرحبا بالعالم، هذا اختبار';
const HEBREW = 'שלום עולם, זו בדיקה';

describe('firstStrongDirection', () => {
  it('reads Arabic and Hebrew as right to left', () => {
    expect(firstStrongDirection(ARABIC)).toBe('rtl');
    expect(firstStrongDirection(HEBREW)).toBe('rtl');
    // Presentation forms, Syriac and Thaana are right to left too.
    expect(firstStrongDirection('ﻣﺮﺣﺒﺎ')).toBe('rtl');
    expect(firstStrongDirection('ܫܠܡܐ')).toBe('rtl');
    expect(firstStrongDirection('ދިވެހި')).toBe('rtl');
  });

  it('reads Latin, CJK and accented letters as left to right', () => {
    expect(firstStrongDirection('hello')).toBe('ltr');
    expect(firstStrongDirection('日本語テスト')).toBe('ltr');
    expect(firstStrongDirection('é')).toBe('ltr');
  });

  it('takes the first strong character of mixed text', () => {
    expect(firstStrongDirection('mixed עם עברית')).toBe('ltr');
    expect(firstStrongDirection('עברית and English')).toBe('rtl');
    expect(firstStrongDirection('[L2i 1036] E-10 RTL: مرحبا')).toBe('ltr');
  });

  it('skips emoji, digits, punctuation and marks before the first letter', () => {
    expect(firstStrongDirection('👨‍👩‍👧‍👦 🎉 שלום')).toBe('rtl');
    expect(firstStrongDirection('2024 مرحبا')).toBe('rtl');
    expect(firstStrongDirection('٢٠٢٤ hello')).toBe('ltr');
    expect(firstStrongDirection('"(!) — hello')).toBe('ltr');
    expect(firstStrongDirection('ًمرحبا')).toBe('rtl');
  });

  it('counts the directional marks', () => {
    expect(firstStrongDirection('‏123 abc')).toBe('rtl');
    expect(firstStrongDirection('‎123 שלום')).toBe('ltr');
    expect(firstStrongDirection('؜123 abc')).toBe('rtl');
  });

  it('has no direction without a strong character', () => {
    expect(firstStrongDirection('')).toBeNull();
    expect(firstStrongDirection('   ')).toBeNull();
    expect(firstStrongDirection('🔥🔥 123 !?')).toBeNull();
  });
});

describe('lineDirections', () => {
  it('gives each paragraph its own direction', () => {
    expect(lineDirections([ARABIC, HEBREW, 'mixed @writes-mina4 עם עברית'])).toEqual(['rtl', 'rtl', 'ltr']);
    expect(lineDirections(['English first', HEBREW, 'English again'])).toEqual(['ltr', 'rtl', 'ltr']);
  });

  it('lets a line without strong characters follow the line before it', () => {
    expect(lineDirections([HEBREW, '2024 🎉', 'english'])).toEqual(['rtl', 'rtl', 'ltr']);
    expect(lineDirections(['english', '🎉', HEBREW])).toEqual(['ltr', 'ltr', 'rtl']);
  });

  it('lets leading neutral lines take the first strong line', () => {
    expect(lineDirections(['🎉', '123', ARABIC])).toEqual(['rtl', 'rtl', 'rtl']);
  });

  it('puts a blank line with the paragraph after it', () => {
    expect(lineDirections([ARABIC, '', 'English'])).toEqual(['rtl', 'ltr', 'ltr']);
    expect(lineDirections(['English', '', '  ', HEBREW])).toEqual(['ltr', 'rtl', 'rtl', 'rtl']);
    expect(lineDirections(['', HEBREW])).toEqual(['rtl', 'rtl']);
  });

  it('keeps trailing blank lines with the paragraph before them', () => {
    expect(lineDirections([HEBREW, '', ''])).toEqual(['rtl', 'rtl', 'rtl']);
  });

  it('has no direction when nothing is strong', () => {
    expect(lineDirections(['🔥', '', '123'])).toEqual([null, null, null]);
    expect(lineDirections([''])).toEqual([null]);
  });
});

describe('directionRuns and directionBlocks', () => {
  it('groups consecutive same-direction lines', () => {
    expect(directionRuns([ARABIC, HEBREW, 'mixed', 'more'])).toEqual([
      { direction: 'rtl', start: 0, end: 2 },
      { direction: 'ltr', start: 2, end: 4 },
    ]);
  });

  it('splits plain text into blocks that join back to the text', () => {
    const text = `${ARABIC}\n${HEBREW}\n\nmixed @bob עם עברית\n🎉`;
    const blocks = directionBlocks(text);
    expect(blocks).toEqual([
      { direction: 'rtl', text: `${ARABIC}\n${HEBREW}` },
      { direction: 'ltr', text: '\nmixed @bob עם עברית\n🎉' },
    ]);
    expect(blocks.map((b) => b.text).join('\n')).toBe(text);
  });

  it('keeps single-direction text in one block', () => {
    expect(directionBlocks('one\n\ntwo')).toEqual([{ direction: 'ltr', text: 'one\n\ntwo' }]);
    expect(directionBlocks('')).toEqual([{ direction: null, text: '' }]);
  });
});

describe('directionStyle', () => {
  it('right-aligns RTL, left-aligns LTR and leaves neutral text natural', () => {
    expect(directionStyle('rtl')).toEqual({ writingDirection: 'rtl', textAlign: 'right' });
    expect(directionStyle('ltr')).toEqual({ writingDirection: 'ltr', textAlign: 'left' });
    expect(directionStyle(null)).toEqual({ writingDirection: 'auto' });
  });
});

describe('blockLineCaps', () => {
  it('leaves blocks unbounded without a limit', () => {
    expect(blockLineCaps([], 3, undefined)).toEqual([undefined, undefined, undefined]);
  });

  it('counts an unmeasured block as one line', () => {
    expect(blockLineCaps([], 3, 4)).toEqual([4, 3, 2]);
  });

  it('gives each block what the blocks above it left, then hides the rest', () => {
    expect(blockLineCaps([3, 5, 2], 3, 4)).toEqual([4, 1, 0]);
    expect(blockLineCaps([10, 6], 2, 12)).toEqual([12, 2]);
    expect(blockLineCaps([20, 1], 2, 12)).toEqual([12, 0]);
  });

  it('counts a reported line count only up to the block cap', () => {
    // Block 0 reported 16 lines unclamped; clamped to 4 it takes all 4.
    expect(blockLineCaps([16, 1], 2, 4)).toEqual([4, 0]);
  });
});
