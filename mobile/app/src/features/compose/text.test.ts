import { composeHints, editorSpans, insertMention, mentionAt, tagMaxLength, tokenize } from './text';

describe('tokenize', () => {
  it('finds links, tags, cashtags and mentions in order', () => {
    expect(tokenize('Hi @bob, see #dash and $DASH at https://yap.pr').map((t) => [t.kind, t.value])).toEqual([
      ['mention', '@bob'],
      ['hashtag', '#dash'],
      ['cashtag', '$DASH'],
      ['url', 'https://yap.pr'],
    ]);
  });

  it('keeps the earlier match where two overlap', () => {
    expect(tokenize('https://x.io/#frag').map((t) => t.kind)).toEqual(['url']);
  });
});

describe('editorSpans', () => {
  it('colors tokens and underlines a tag over the limit', () => {
    const long = `#${'a'.repeat(62)}`;
    expect(editorSpans(`hi #ok ${long}`, 61, null)).toEqual([
      { text: 'hi ', style: 'plain', over: false },
      { text: '#ok', style: 'link', over: false },
      { text: ' ', style: 'plain', over: false },
      { text: long, style: 'tagTooLong', over: false },
    ]);
  });

  it('marks everything from the overflow on, splitting a token', () => {
    expect(editorSpans('ab #tag', 61, 5)).toEqual([
      { text: 'ab ', style: 'plain', over: false },
      { text: '#t', style: 'link', over: false },
      { text: 'ag', style: 'link', over: true },
    ]);
  });

  it('joins back to the text', () => {
    const text = 'Hello 👋 @alice #tag https://yap.pr 日本';
    expect(
      editorSpans(text, 61, 9)
        .map((s) => s.text)
        .join(''),
    ).toBe(text);
  });
});

describe('mentionAt', () => {
  it('opens after @ and 3 characters at the caret', () => {
    expect(mentionAt('hi @al', 6)).toBeNull();
    expect(mentionAt('hi @ali', 7)).toEqual({ start: 3, end: 7, query: 'ali' });
    expect(mentionAt('@sou', 4)).toEqual({ start: 0, end: 4, query: 'sou' });
  });

  it('closes after a space and ignores email addresses', () => {
    expect(mentionAt('hi @alice ', 10)).toBeNull();
    expect(mentionAt('mail me@example', 15)).toBeNull();
  });

  it('reads only up to the caret', () => {
    expect(mentionAt('hi @alice rest', 8)).toEqual({ start: 3, end: 8, query: 'alic' });
  });
});

describe('insertMention', () => {
  it('replaces the fragment with "@username " and puts the caret after it', () => {
    const text = 'hi @ali and more';
    const at = mentionAt(text, 7);
    expect(at).not.toBeNull();
    if (!at) return;
    expect(insertMention(text, at, 'alice-1')).toEqual({ text: 'hi @alice-1 and more', caret: 12 });
  });
});

describe('composeHints', () => {
  it('flags a second mention and a second tag, case-insensitively', () => {
    expect(composeHints('@a @A #x #X', 61)).toEqual({ tagTooLong: false, secondMention: false, secondTag: false });
    expect(composeHints('@a @b #x $Y', 61)).toEqual({ tagTooLong: false, secondMention: true, secondTag: true });
  });

  it('flags a tag over the contract limit (61 on dev, 63 elsewhere)', () => {
    expect(tagMaxLength(true)).toBe(61);
    expect(tagMaxLength(false)).toBe(63);
    expect(composeHints(`#${'a'.repeat(62)}`, 61).tagTooLong).toBe(true);
    expect(composeHints(`#${'a'.repeat(62)}`, 63).tagTooLong).toBe(false);
  });
});
