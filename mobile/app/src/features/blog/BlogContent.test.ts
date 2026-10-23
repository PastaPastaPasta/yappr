import { inlineText } from './blocks';
import { contentModel } from './BlogContent';

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];
const heading = (id: string, value: string) => ({ id, type: 'heading', props: { level: 2 }, content: text(value) });
const paragraph = (id: string) => ({ id, type: 'paragraph', content: text(id) });
const footnote = (id: string, value: string) => ({ id, type: 'footnote', content: text(value) });
const numbered = (id: string) => ({ id, type: 'numberedListItem', content: text(id) });

describe('contentModel', () => {
  // The table of contents names a heading by its index among the top-level headings, empty ones included.
  const blocks = [
    footnote('f1', 'First note'),
    heading('h0', ''),
    paragraph('p1'),
    heading('h1', 'Alpha'),
    footnote('f2', 'Second note'),
    numbered('n1'),
    numbered('n2'),
    paragraph('p2'),
    numbered('n3'),
    heading('h2', 'Beta'),
  ];
  const model = contentModel(blocks);

  it('gives every block a row except footnotes, which are listed under the post', () => {
    expect(model.rows.map((row) => row.block.id)).toEqual(['h0', 'p1', 'h1', 'n1', 'n2', 'p2', 'n3', 'h2']);
    expect(model.footnotes).toEqual(['First note', 'Second note']);
  });

  it('maps each table of contents entry to the row of its heading', () => {
    expect(model.toc.map((entry) => entry.text)).toEqual(['Alpha', 'Beta']);
    for (const entry of model.toc) {
      const row = model.rows[model.headingRows[entry.index]];
      expect(row.block.type).toBe('heading');
      expect(inlineText(row.block.content).trim()).toBe(entry.text);
    }
  });

  it('numbers list items until another kind of block breaks the run', () => {
    expect(model.rows.map((row) => row.number)).toEqual([0, 0, 0, 1, 2, 0, 1, 0]);
  });

  it('keys every row differently, even when ids repeat', () => {
    const twice = contentModel([paragraph('same'), paragraph('same'), { type: 'paragraph', content: text('no id') }]);
    expect(new Set(twice.rows.map((row) => row.key)).size).toBe(3);
  });
});
