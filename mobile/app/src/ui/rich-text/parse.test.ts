import {
  displayText,
  extractFirstUrl,
  inlineTargets,
  lineText,
  parseContent,
  splitLines,
  splitUrl,
  stripFirstUrlAndTrim,
  stripLink,
  stripTrailingPunctuation,
  tagTarget,
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

  it('takes a tag longer than the contract indexes whole, as compose does', () => {
    const tag = `#longtag${'x'.repeat(58)}`; // 65 characters after the #
    expect(parseContent(`a ${tag} b`)).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'hashtag', value: tag },
      { type: 'text', value: ' b' },
    ]);
    const cashtag = `$${'A'.repeat(70)}`;
    expect(parseContent(cashtag)).toEqual([{ type: 'cashtag', value: cashtag }]);
  });

  it.each(['#café', '#naïve', '#straße', '#cafe\u0301', '#日本', '#abc日本', '$DASHé'])(
    'leaves %s as plain text, never a shorter ASCII tag (D7)',
    (word) => {
      expect(parseContent(`a ${word} b`)).toEqual([{ type: 'text', value: `a ${word} b` }]);
    },
  );

  it('ends a tag at punctuation and emoji, as web does', () => {
    expect(
      parseContent('#ok! #fine🙂 (#paren)')
        .filter((p) => p.type === 'hashtag')
        .map((p) => p.value),
    ).toEqual(['#ok', '#fine', '#paren']);
  });

  it('allows hyphens in mentions, as DPNS labels do', () => {
    expect(parseContent('@my-name')).toEqual([{ type: 'mention', value: '@my-name' }]);
  });
});

describe('tagTarget', () => {
  it('gives the storage form of a tag that fits, else null', () => {
    expect(tagTarget('#Dash', 61)).toBe('dash');
    expect(tagTarget('$DASH', 61)).toBe('dash_cashtag');
    expect(tagTarget(`#${'a'.repeat(61)}`, 61)).toBe('a'.repeat(61));
    expect(tagTarget(`#${'a'.repeat(62)}`, 61)).toBeNull();
    expect(tagTarget(`$${'A'.repeat(54)}`, 61)).toBeNull();
  });

  it('links every tag when no ceiling is known', () => {
    expect(tagTarget(`#${'a'.repeat(200)}`, undefined)).toBe('a'.repeat(200));
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

  it('lists no tag too long to index, nor a non-ASCII word', () => {
    const long = `#${'a'.repeat(62)}`;
    expect(inlineTargets(`#ok ${long} #café $DASH`, 61).map((t) => t.value)).toEqual(['#ok', '$DASH']);
    expect(inlineTargets(`#ok ${long}`).map((t) => t.value)).toEqual(['#ok', long]);
  });
});

describe('splitLines', () => {
  it('splits the parts at every line break, blank lines included', () => {
    const lines = splitLines(parseContent('שלום #tag\n\nhi @bob'));
    expect(lines).toEqual([
      [
        { type: 'text', value: 'שלום ' },
        { type: 'hashtag', value: '#tag' },
      ],
      [],
      [
        { type: 'text', value: 'hi ' },
        { type: 'mention', value: '@bob' },
      ],
    ]);
    expect(lines.map(lineText)).toEqual(['שלום #tag', '', 'hi @bob']);
  });

  it('continues a bold or code run that spans a line break on the next line', () => {
    expect(splitLines(parseContent('**שלום\nhi #x** `a\nb`'))).toEqual([
      [{ type: 'bold', value: 'שלום', children: [{ type: 'text', value: 'שלום' }] }],
      [
        {
          type: 'bold',
          value: 'hi #x',
          children: [
            { type: 'text', value: 'hi ' },
            { type: 'hashtag', value: '#x' },
          ],
        },
        { type: 'text', value: ' ' },
        { type: 'code', value: 'a' },
      ],
      [{ type: 'code', value: 'b' }],
    ]);
  });

  it('gives empty text one empty line', () => {
    expect(splitLines(parseContent(''))).toEqual([[]]);
  });
});
