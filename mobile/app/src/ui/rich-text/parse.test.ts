import { parseContent, splitUrl, stripTrailingPunctuation } from './parse';

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
      { type: 'bold', value: 'hi #tag', children: [{ type: 'text', value: 'hi ' }, { type: 'hashtag', value: '#tag' }] },
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
    expect(splitUrl('www.dash.org.')).toEqual({ href: 'https://www.dash.org', display: 'www.dash.org', trailing: '.' });
  });

  it('keeps balanced parentheses in the target', () => {
    expect(stripTrailingPunctuation('https://en.wikipedia.org/wiki/Dash_(cryptocurrency)')).toBe(
      'https://en.wikipedia.org/wiki/Dash_(cryptocurrency)',
    );
    expect(stripTrailingPunctuation('https://x.org/a)')).toBe('https://x.org/a');
  });
});
