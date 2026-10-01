import {
  displayText,
  extractFirstUrl,
  inlineTargets,
  parseContent,
  splitUrl,
  stripFirstUrlAndTrim,
  stripLink,
  stripTrailingPunctuation,
} from './parse';

describe('parseContent (web PostContent parity)', () => {
  it('splits mentions, hashtags, cashtags and links out of plain text', () => {
    expect(parseContent('Hi @bob.dash see #Dash $dash at https://yap.pr!')).toEqual([
      { type: 'text', value: 'Hi ' },
      { type: 'mention', value: '@bob.dash' },
      { type: 'text', value: ' see ' },
      { type: 'hashtag', value: '#Dash' },
      { type: 'text', value: ' ' },
      { type: 'cashtag', value: '$dash' },
      { type: 'text', value: ' at ' },
      { type: 'url', value: 'https://yap.pr!' },
    ]);
  });

  it('parses inside bold and italic, but keeps code literal', () => {
    expect(parseContent('**hi #tag** *it* `@not`')).toEqual([
      {
        type: 'bold',
        value: 'hi #tag',
        children: [
          { type: 'text', value: 'hi ' },
          { type: 'hashtag', value: '#tag' },
        ],
      },
      { type: 'text', value: ' ' },
      { type: 'italic', value: 'it', children: [{ type: 'text', value: 'it' }] },
      { type: 'text', value: ' ' },
      { type: 'code', value: '@not' },
    ]);
  });

  it('keeps the earliest of overlapping matches (a URL swallows its #fragment)', () => {
    expect(parseContent('https://x.org/#top')).toEqual([{ type: 'url', value: 'https://x.org/#top' }]);
  });

  it('passes emoji and RTL text through whole', () => {
    const text = '👩🏽‍💻 שלום #hebrew עולם';
    const parts = parseContent(text);
    expect(parts.map((p) => p.value).join('')).toBe(text);
    expect(parts.find((p) => p.type === 'hashtag')?.value).toBe('#hebrew');
  });

  it('allows hyphens in mentions, as DPNS labels do', () => {
    expect(parseContent('@my-name')).toEqual([{ type: 'mention', value: '@my-name' }]);
  });
});

describe('splitUrl', () => {
  it('keeps trailing punctuation outside the link and prefixes www.', () => {
    expect(splitUrl('www.dash.org.')).toEqual({
      href: 'https://www.dash.org',
      display: 'www.dash.org',
      trailing: '.',
    });
  });

  it('keeps balanced parentheses in the target', () => {
    expect(stripTrailingPunctuation('https://en.wikipedia.org/wiki/Dash_(cryptocurrency)')).toBe(
      'https://en.wikipedia.org/wiki/Dash_(cryptocurrency)',
    );
    expect(stripTrailingPunctuation('https://x.org/a)')).toBe('https://x.org/a');
  });
});

describe('web text stripping parity', () => {
  it('drops the previewed first URL from the raw text, even inside bold', () => {
    const text = '**see https://a.com now** https://b.com';
    expect(extractFirstUrl(text)).toBe('https://a.com');
    expect(displayText(text, true)).toBe('**see  now** https://b.com');
  });

  it('keeps trailing punctuation and trims', () => {
    expect(stripFirstUrlAndTrim('Read www.dash.org.', 'https://www.dash.org')).toBe('Read .');
    expect(stripFirstUrlAndTrim('Read https://x.org', 'https://other.org')).toBe('Read https://x.org');
  });

  it('removes a legacy poll link everywhere it appears', () => {
    expect(stripLink('Vote! https://pollr.app/p/1 \nthanks', 'https://pollr.app/p/1')).toBe('Vote!\nthanks');
  });

  it('lists the tappable spans in reading order, bold included', () => {
    expect(inlineTargets('hi @bob **#tag** `@code` https://x.org').map((t) => t.value)).toEqual([
      '@bob',
      '#tag',
      'https://x.org',
    ]);
  });
});
