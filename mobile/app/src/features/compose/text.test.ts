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
  it('colors tokens, and leaves a tag too long to index plain (#11)', () => {
    const long = `#${'a'.repeat(62)}`;
    expect(editorSpans(`hi #ok ${long}`, 61, null)).toEqual([
      { text: 'hi ', style: 'plain', over: false },
      { text: '#ok', style: 'link', over: false },
      { text: ' ', style: 'plain', over: false },
      { text: long, style: 'plain', over: false },
    ]);
    // Where the contract indexes tags that long (63), it is a link.
    expect(editorSpans(long, 63, null)).toEqual([{ text: long, style: 'link', over: false }]);
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
  it('names the one mention notified once there are two different ones (#11)', () => {
    expect(composeHints('@alice hi')).toEqual({ notified: null });
    expect(composeHints('@alice and @Alice')).toEqual({ notified: null });
    expect(composeHints('hi @bob and @alice #x #y')).toEqual({ notified: '@bob' });
  });

  it('says nothing about tags (#11)', () => {
    expect(composeHints(`#one #two #${'a'.repeat(70)}`)).toEqual({ notified: null });
  });

  it('knows the longest tag each contract indexes (61 on dev, 63 elsewhere)', () => {
    expect(tagMaxLength(true)).toBe(61);
    expect(tagMaxLength(false)).toBe(63);
  });
});
