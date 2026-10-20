import {
  fromEditorBlocks,
  fromMarkup,
  hasContent,
  headingLinks,
  inlineRuns,
  newEditorBlock,
  simpleTableCells,
  tableCells,
  toEditorBlocks,
  toMarkup,
  wrapSelection,
  type RawBlock,
} from './blocks';

/** A post as the web's BlockNote editor stores it. */
const WEB_POST: RawBlock[] = [
  { id: 'h1', type: 'heading', props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'left', level: 1, isToggleable: false }, content: [{ type: 'text', text: 'Field notes', styles: {} }], children: [] },
  { id: 'toc', type: 'tableOfContents', props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' }, children: [] },
  {
    id: 'p1',
    type: 'paragraph',
    props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' },
    content: [
      { type: 'text', text: 'Plain, ', styles: {} },
      { type: 'text', text: 'bold', styles: { bold: true } },
      { type: 'text', text: ' and ', styles: {} },
      { type: 'link', href: 'https://yap.pr', content: [{ type: 'text', text: 'a link', styles: { italic: true } }] },
      { type: 'text', text: ' with snake_case and `ticks`.', styles: {} },
    ],
    children: [],
  },
  { id: 'red', type: 'paragraph', props: { textColor: 'red', backgroundColor: 'default', textAlignment: 'left' }, content: [{ type: 'text', text: 'Red text', styles: {} }], children: [] },
  { id: 'ul', type: 'bulletListItem', props: {}, content: [{ type: 'text', text: 'Parent', styles: {} }], children: [{ id: 'child', type: 'bulletListItem', props: {}, content: 'Child', children: [] }] },
  { id: 'tbl', type: 'simpleTable', props: { rows: 2, cols: 2, data: '[["a","b"],["c","d"]]' }, children: [] },
  { id: 'code', type: 'codeBlock', props: { language: 'typescript', code: 'const x = 1' }, children: [] },
  { id: 'img', type: 'image', props: { url: 'https://example.com/a.png', caption: 'A cat', name: '', showPreview: true, previewWidth: 512 }, children: [] },
  { id: 'q', type: 'quote', props: { textColor: 'default', backgroundColor: 'default' }, content: [{ type: 'text', text: 'Quoted', styles: {} }], children: [] },
];

describe('blog blocks', () => {
  it('writes an untouched post back exactly as stored', () => {
    expect(fromEditorBlocks(toEditorBlocks(WEB_POST))).toEqual(WEB_POST);
  });

  it('locks what the markup cannot say, and keeps it verbatim', () => {
    const kinds = toEditorBlocks(WEB_POST).map((block) => block.kind);
    expect(kinds).toEqual(['heading', 'tableOfContents', 'paragraph', 'locked', 'locked', 'locked', 'codeBlock', 'image', 'quote']);
  });

  it('keeps inline styles and links through an edit', () => {
    const blocks = toEditorBlocks(WEB_POST);
    const paragraph = blocks[2];
    expect(paragraph.text).toBe('Plain, **bold** and [*a link*](https://yap.pr) with snake\\_case and \\`ticks\\`.');
    const edited = fromEditorBlocks([{ ...paragraph, text: `${paragraph.text} More.` }])[0];
    expect(inlineRuns(edited.content)).toEqual([
      { text: 'Plain, ' },
      { text: 'bold', bold: true },
      { text: ' and ' },
      { text: 'a link', italic: true, href: 'https://yap.pr' },
      { text: ' with snake_case and `ticks`. More.' },
    ]);
    expect(edited.id).toBe('p1');
    expect(edited.props).toEqual(WEB_POST[2].props);
  });

  it('reads markup a writer types', () => {
    expect(fromMarkup('a **b** *c* ***d*** `e` snake_case _f_ [g](https://x.y) 5 * 3')).toEqual([
      { type: 'text', text: 'a ', styles: {} },
      { type: 'text', text: 'b', styles: { bold: true } },
      { type: 'text', text: ' ', styles: {} },
      { type: 'text', text: 'c', styles: { italic: true } },
      { type: 'text', text: ' ', styles: {} },
      { type: 'text', text: 'd', styles: { bold: true, italic: true } },
      { type: 'text', text: ' ', styles: {} },
      { type: 'text', text: 'e', styles: { code: true } },
      { type: 'text', text: ' snake_case ', styles: {} },
      { type: 'text', text: 'f', styles: { italic: true } },
      { type: 'text', text: ' ', styles: {} },
      { type: 'link', href: 'https://x.y', content: [{ type: 'text', text: 'g', styles: {} }] },
      { type: 'text', text: ' 5 * 3', styles: {} },
    ]);
  });

  it('round-trips every run style the markup knows', () => {
    const runs = [{ text: 'x*y_' }, { text: 'b', bold: true }, { text: 'i', italic: true }, { text: 'bi', bold: true, italic: true }, { text: 'c', code: true }];
    const content = fromMarkup(toMarkup(runs));
    expect(inlineRuns(content)).toEqual(runs);
  });

  it('builds new blocks in the shape the web editor reads', () => {
    const blocks = fromEditorBlocks([
      { ...newEditorBlock('heading'), text: 'Title' },
      { ...newEditorBlock('numberedListItem'), text: 'One' },
      { ...newEditorBlock('checkListItem'), text: 'Done', checked: true },
      { ...newEditorBlock('image'), url: ' https://example.com/b.png ', caption: 'Caption' },
      newEditorBlock('divider'),
    ]);
    expect(blocks.map((block) => block.type)).toEqual(['heading', 'numberedListItem', 'checkListItem', 'image', 'divider']);
    expect(blocks[0]).toMatchObject({ props: { level: 2, isToggleable: false, textAlignment: 'left' }, content: [{ type: 'text', text: 'Title', styles: {} }], children: [] });
    expect(blocks[2].props).toMatchObject({ checked: true });
    expect(blocks[3].props).toMatchObject({ url: 'https://example.com/b.png', caption: 'Caption', previewWidth: 512 });
    expect(typeof blocks[0].id).toBe('string');
  });

  it('drops a deleted locked block only when the writer removes it', () => {
    const blocks = toEditorBlocks(WEB_POST).filter((block) => block.original?.id !== 'tbl');
    expect(fromEditorBlocks(blocks).map((block) => block.id)).not.toContain('tbl');
  });

  it('lists the table of contents and tables as the web does', () => {
    expect(headingLinks([...WEB_POST, { type: 'heading', props: { level: 2 }, content: [] }, { type: 'heading', props: { level: 2 }, content: 'Second' }])).toEqual([
      { index: 0, text: 'Field notes', level: 1 },
      { index: 2, text: 'Second', level: 2 },
    ]);
    expect(simpleTableCells(WEB_POST[5].props)).toEqual([['a', 'b'], ['c', 'd']]);
    expect(tableCells({ type: 'tableContent', rows: [{ cells: [[{ type: 'text', text: 'x', styles: {} }], 'y'] }] })).toEqual([['x', 'y']]);
  });

  it('locks text with an inline color or a link the markup cannot read back', () => {
    const colored: RawBlock = { id: 'c', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Red', styles: { textColor: 'red' } }] };
    const plain: RawBlock = { id: 'p', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Plain', styles: { textColor: 'default', bold: true } }] };
    const anchor: RawBlock = { id: 'a', type: 'paragraph', props: {}, content: [{ type: 'link', href: '#part', content: [{ type: 'text', text: 'jump', styles: {} }] }] };
    expect(toEditorBlocks([colored, plain, anchor]).map((block) => block.kind)).toEqual(['locked', 'paragraph', 'locked']);
  });

  it('keeps code exact: link syntax in code stays code, and styled code is locked', () => {
    const code = { text: '[a](https://example.com)', code: true };
    expect(inlineRuns(fromMarkup(toMarkup([{ text: 'see ' }, code])))).toEqual([{ text: 'see ' }, code]);
    const boldCode: RawBlock = { id: 'b', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'x', styles: { bold: true, code: true } }] };
    expect(toEditorBlocks([boldCode])[0].kind).toBe('locked');
    const codeLink: RawBlock = {
      id: 'l', type: 'paragraph', props: {},
      content: [{ type: 'link', href: 'https://example.com', content: [{ type: 'text', text: 'items[0]', styles: { code: true } }] }],
    };
    expect(toEditorBlocks([codeLink])[0].kind).toBe('locked');
  });

  it('knows an empty draft and wraps a selection', () => {
    expect(hasContent([newEditorBlock('paragraph')])).toBe(false);
    expect(hasContent([{ ...newEditorBlock('paragraph'), text: 'x' }])).toBe(true);
    expect(wrapSelection('hello world', { start: 6, end: 11 }, '**')).toEqual({ text: 'hello **world**', selection: { start: 8, end: 13 } });
  });
});
