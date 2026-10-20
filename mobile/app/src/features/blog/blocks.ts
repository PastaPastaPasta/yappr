/**
 * Blog post content: the web editor's BlockNote JSON (`components/blog/blocknote-schema.tsx`),
 * read as it is stored, and the native editor's model of it.
 *
 * The native editor edits a block as one line of text with light markup
 * (`**bold**`, `*italic*`, `` `code` ``, `[text](https://…)`). A block it can't
 * express that way (a table, a video, colored text, nested items, …) stays
 * exactly as stored and is shown as "edit on the web". A block the writer
 * did not change is written back verbatim, so an edit on the phone never
 * disturbs what it didn't touch, and a post round-trips with the web.
 */

export type RawBlock = Record<string, unknown> & { id?: string; type?: string; props?: Record<string, unknown>; content?: unknown; children?: unknown };

export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** Set when the run is (part of) a link. */
  href?: string;
  underline?: boolean;
  strike?: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A block list as stored; anything that isn't a block object is dropped. */
export function blocksOf(value: unknown): RawBlock[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

/** Inline content as runs (text and links); a plain string is one run. */
export function inlineRuns(content: unknown): InlineRun[] {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const runs: InlineRun[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      if (item) runs.push({ text: item });
    } else if (isObject(item) && item.type === 'link') {
      const href = typeof item.href === 'string' ? item.href : '';
      for (const run of inlineRuns(item.content)) runs.push({ ...run, href });
    } else if (isObject(item) && typeof item.text === 'string') {
      const styles = isObject(item.styles) ? item.styles : {};
      runs.push({
        text: item.text,
        ...(styles.bold === true ? { bold: true } : {}),
        ...(styles.italic === true ? { italic: true } : {}),
        ...(styles.code === true ? { code: true } : {}),
        ...(styles.underline === true ? { underline: true } : {}),
        ...(styles.strike === true ? { strike: true } : {}),
      });
    }
  }
  return runs;
}

/** The plain text of inline content (`extractInlineText`). */
export function inlineText(content: unknown): string {
  return inlineRuns(content).map((run) => run.text).join('');
}

export interface HeadingLink {
  /** The heading's index among the post's top-level headings (web's `toc-heading-<n>`). */
  index: number;
  text: string;
  level: number;
}

/** The table of contents: every top-level heading with text, in order (web's `getHeadingLinks`). */
export function headingLinks(blocks: readonly RawBlock[]): HeadingLink[] {
  return blocks
    .filter((block) => block.type === 'heading')
    .map((block, index) => ({ index, text: inlineText(block.content).trim(), level: headingLevel(block) }))
    .filter((heading) => heading.text !== '');
}

export function headingLevel(block: RawBlock): number {
  const level = Number(block.props?.level ?? 1);
  return level >= 1 && level <= 6 ? Math.round(level) : 1;
}

/** Footnotes, numbered in order, as web lists them under the post. */
export function footnotesOf(blocks: readonly RawBlock[]): string[] {
  return blocks
    .filter((block) => block.type === 'footnote')
    .map((block) => inlineText(block.content).trim())
    .filter(Boolean);
}

/** A simple table's cells (`parseTableData`): rows × cols strings. */
export function simpleTableCells(props: Record<string, unknown> | undefined): string[][] {
  const rows = Math.min(12, Math.max(1, Number(props?.rows ?? 3) || 3));
  const cols = Math.min(6, Math.max(1, Number(props?.cols ?? 3) || 3));
  let parsed: unknown = null;
  try {
    parsed = typeof props?.data === 'string' ? JSON.parse(props.data) : null;
  } catch {
    parsed = null;
  }
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => {
      const row = Array.isArray(parsed) ? parsed[r] : null;
      const cell = Array.isArray(row) ? row[c] : null;
      return typeof cell === 'string' ? cell : '';
    }),
  );
}

/** A BlockNote table's cells (`tableContent`) as plain text rows. */
export function tableCells(content: unknown): string[][] {
  if (!isObject(content) || !Array.isArray(content.rows)) return [];
  return content.rows.map((row) => {
    const cells = isObject(row) && Array.isArray(row.cells) ? row.cells : [];
    return cells.map((cell) => (isObject(cell) && 'content' in cell ? inlineText(cell.content) : inlineText(cell)));
  });
}

// ---- the native editor's model -------------------------------------------

/** The block kinds the native editor writes. */
export const EDITABLE_KINDS = [
  'paragraph',
  'heading',
  'bulletListItem',
  'numberedListItem',
  'checkListItem',
  'quote',
  'codeBlock',
  'image',
  'divider',
  'tableOfContents',
] as const;

export type EditableKind = (typeof EDITABLE_KINDS)[number];

export interface EditorBlock {
  /** Stable for React and for the stored block's id. */
  key: string;
  kind: EditableKind | 'locked';
  /** Text blocks: the text with markup. Code: the code. */
  text: string;
  /** Headings: 1–3. */
  level?: number;
  /** Checklist items. */
  checked?: boolean;
  /** Code blocks. */
  language?: string;
  /** Images. */
  url?: string;
  caption?: string;
  /** The block as stored, when it came from the post. */
  original?: RawBlock;
}

/** The block types the native editor can't edit, as a writer would name them. */
export const LOCKED_BLOCK_NAMES: Record<string, string> = {
  table: 'Table',
  simpleTable: 'Table',
  video: 'Video',
  videoEmbed: 'Video',
  audio: 'Audio',
  file: 'File',
  callout: 'Callout',
  backgroundSection: 'Highlighted section',
  columnLayout: 'Columns',
  footnote: 'Footnote',
  spacer: 'Spacer',
  toggleListItem: 'Toggle list',
};

/** A link address the markup writes and reads back. */
const LINK_HREF = /^(?:https?|ipfs|mailto):[^\s]+$/;

const MARKUP_STYLES = new Set(['bold', 'italic', 'code']);

const TEXT_KINDS = new Set<string>(['paragraph', 'heading', 'bulletListItem', 'numberedListItem', 'checkListItem', 'quote']);
const DEFAULT_PROP_VALUES: Record<string, unknown> = { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' };

/** True when inline content only uses what the markup can say (bold, italic, code, links). */
function markupCanSay(content: unknown): boolean {
  if (content === undefined || content === '') return true;
  if (!Array.isArray(content)) return typeof content === 'string';
  return content.every((item) => {
    if (typeof item === 'string') return true;
    if (!isObject(item)) return false;
    // Only a link the markup can read back (`LINK`): a relative or `#anchor` one would turn into literal text.
    if (item.type === 'link') return typeof item.href === 'string' && LINK_HREF.test(item.href) && markupCanSay(item.content);
    if (item.type !== 'text' || typeof item.text !== 'string') return false;
    const styles = isObject(item.styles) ? item.styles : {};
    // Code is written alone between backticks: code that is also bold or italic, or holds a backtick, can't be.
    if (styles.code === true && (styles.bold === true || styles.italic === true || item.text.includes('`'))) return false;
    // Bold, italic and code are all the markup says; any other style that is set (a color, an underline) locks the block.
    return Object.entries(styles).every(([style, value]) =>
      value === true ? MARKUP_STYLES.has(style) : value === false || value === undefined || value === '' || value === 'default');
  });
}

/** Adjacent runs with the same styles and link as one run (how the markup reads them back). */
function mergeRuns(runs: readonly InlineRun[]): InlineRun[] {
  const out: InlineRun[] = [];
  const style = (run: InlineRun) => JSON.stringify({ ...run, text: '' });
  for (const run of runs) {
    if (!run.text) continue;
    const last = out[out.length - 1];
    if (last && style(last) === style(run)) out[out.length - 1] = { ...last, text: last.text + run.text };
    else out.push({ ...run });
  }
  return out;
}

/**
 * Whether inline content survives the markup unchanged: written as markup and
 * read back, it is the same text, styles and links. Whatever the markup can't
 * say exactly (a bracket in a code link label, an odd escape) locks the block
 * rather than change on the first edit.
 */
function roundTrips(content: unknown): boolean {
  const runs = mergeRuns(inlineRuns(content));
  return JSON.stringify(mergeRuns(inlineRuns(fromMarkup(toMarkup(runs))))) === JSON.stringify(runs);
}

/** Props the editor would lose: colors, alignment, a toggle heading. */
function hasStyledProps(block: RawBlock): boolean {
  const props = block.props ?? {};
  return Object.entries(DEFAULT_PROP_VALUES).some(([prop, value]) => props[prop] !== undefined && props[prop] !== value) ||
    props.isToggleable === true;
}

const hasChildren = (block: RawBlock) => Array.isArray(block.children) && block.children.length > 0;

let keySeed = 0;
/** A fresh block id, in BlockNote's own uuid shape. */
export function newBlockId(): string {
  keySeed += 1;
  const random = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${random()}${random()}-${random()}-4${random().slice(1)}-a${random().slice(1)}-${random()}${random()}${(keySeed % 0x10000).toString(16).padStart(4, '0')}`;
}

/** One stored block as the editor sees it. */
export function toEditorBlock(block: RawBlock): EditorBlock {
  const key = typeof block.id === 'string' && block.id ? block.id : newBlockId();
  const type = block.type ?? '';
  const locked = (): EditorBlock => ({ key, kind: 'locked', text: inlineText(block.content), original: block });
  if (hasChildren(block)) return locked();
  if (TEXT_KINDS.has(type)) {
    if (hasStyledProps(block) || !markupCanSay(block.content) || !roundTrips(block.content)) return locked();
    const level = type === 'heading' ? headingLevel(block) : undefined;
    if (level !== undefined && level > 3) return locked();
    return {
      key,
      kind: type as EditableKind,
      text: toMarkup(inlineRuns(block.content)),
      ...(level !== undefined ? { level } : {}),
      ...(type === 'checkListItem' ? { checked: block.props?.checked === true } : {}),
      original: block,
    };
  }
  if (type === 'codeBlock') {
    // The web's code block keeps its code in props; BlockNote's own uses inline content.
    const code = typeof block.props?.code === 'string' ? block.props.code : inlineText(block.content);
    return { key, kind: 'codeBlock', text: code, language: String(block.props?.language ?? 'javascript'), original: block };
  }
  if (type === 'image') {
    return { key, kind: 'image', text: '', url: String(block.props?.url ?? ''), caption: String(block.props?.caption ?? ''), original: block };
  }
  if (type === 'divider' || type === 'tableOfContents') return { key, kind: type, text: '', original: block };
  return locked();
}

export function toEditorBlocks(blocks: readonly RawBlock[]): EditorBlock[] {
  return blocks.map(toEditorBlock);
}

/** A new empty block of `kind`. */
export function newEditorBlock(kind: EditableKind, extra: Partial<EditorBlock> = {}): EditorBlock {
  return {
    key: newBlockId(),
    kind,
    text: '',
    ...(kind === 'heading' ? { level: 2 } : {}),
    ...(kind === 'checkListItem' ? { checked: false } : {}),
    ...(kind === 'codeBlock' ? { language: 'javascript' } : {}),
    ...(kind === 'image' ? { url: '', caption: '' } : {}),
    ...extra,
  };
}

/** Whether the editor changed a block it read (an unchanged one is written back as stored). */
function unchanged(block: EditorBlock): boolean {
  if (!block.original) return false;
  const again = toEditorBlock(block.original);
  return again.kind === block.kind && again.text === block.text && again.level === block.level &&
    again.checked === block.checked && again.language === block.language && again.url === block.url && again.caption === block.caption;
}

/** The editor's blocks as BlockNote JSON. */
export function fromEditorBlocks(blocks: readonly EditorBlock[]): RawBlock[] {
  return blocks.flatMap((block): RawBlock[] => {
    if (block.original && (block.kind === 'locked' || unchanged(block))) return [block.original];
    if (block.kind === 'locked') return [];
    const base = { id: typeof block.original?.id === 'string' ? block.original.id : block.key, children: [] };
    const kept = block.original?.type === block.kind ? (block.original.props ?? {}) : {};
    switch (block.kind) {
      case 'codeBlock':
        return [{ ...base, type: 'codeBlock', props: { ...DEFAULT_PROP_VALUES, ...kept, language: block.language ?? 'javascript', code: block.text } }];
      case 'image':
        return [{ ...base, type: 'image', props: { ...DEFAULT_PROP_VALUES, name: '', showPreview: true, previewWidth: 512, ...kept, url: (block.url ?? '').trim(), caption: (block.caption ?? '').trim() } }];
      case 'divider':
        return [{ ...base, type: 'divider', props: { ...DEFAULT_PROP_VALUES, variant: 'solid', ...kept } }];
      case 'tableOfContents':
        return [{ ...base, type: 'tableOfContents', props: { ...DEFAULT_PROP_VALUES, ...kept } }];
      default: {
        const props: Record<string, unknown> = { ...DEFAULT_PROP_VALUES, ...kept };
        if (block.kind === 'heading') Object.assign(props, { level: block.level ?? 2, isToggleable: false });
        if (block.kind === 'checkListItem') props.checked = block.checked === true;
        return [{ ...base, type: block.kind, props, content: fromMarkup(block.text) }];
      }
    }
  });
}

/** Whether any block has something to publish. */
export function hasContent(blocks: readonly EditorBlock[]): boolean {
  return blocks.some((block) =>
    block.kind === 'locked' || block.kind === 'divider' || block.kind === 'tableOfContents'
      ? true
      : block.kind === 'image'
        ? Boolean(block.url?.trim())
        : block.text.trim() !== '',
  );
}

// ---- markup ---------------------------------------------------------------

const ESCAPABLE = /[\\*_`[\]]/g;
const escapeText = (text: string) => text.replace(ESCAPABLE, (char) => `\\${char}`);

/** Runs as markup text: `**bold**`, `*italic*`, `` `code` ``, `[text](href)`. */
export function toMarkup(runs: readonly InlineRun[]): string {
  let out = '';
  let index = 0;
  const styled = (run: InlineRun) => {
    if (run.code) return `\`${run.text.replace(/`/g, 'ˋ')}\``;
    let text = escapeText(run.text);
    if (run.italic) text = `*${text}*`;
    if (run.bold) text = `**${text}**`;
    return text;
  };
  while (index < runs.length) {
    const run = runs[index];
    if (run.href !== undefined) {
      const href = run.href;
      let label = '';
      while (index < runs.length && runs[index].href === href) {
        label += styled({ ...runs[index], href: undefined });
        index += 1;
      }
      out += `[${label}](${href.replace(/\)/g, '%29')})`;
    } else {
      out += styled(run);
      index += 1;
    }
  }
  return out;
}

type InlineItem =
  | { type: 'text'; text: string; styles: Record<string, true> }
  | { type: 'link'; href: string; content: { type: 'text'; text: string; styles: Record<string, true> }[] };

function stylesOf(bold: boolean, italic: boolean, code: boolean): Record<string, true> {
  return { ...(bold ? { bold: true as const } : {}), ...(italic ? { italic: true as const } : {}), ...(code ? { code: true as const } : {}) };
}

/** Parses markup into styled text runs (no links). A marker with no partner is literal text. */
function parseStyled(source: string): { text: string; styles: Record<string, true> }[] {
  const out: { text: string; styles: Record<string, true> }[] = [];
  let bold = false;
  let italic = false;
  let buffer = '';
  const flush = (code = false) => {
    if (buffer) {
      const styles = stylesOf(bold, italic, code);
      const last = out[out.length - 1];
      if (!code && last && JSON.stringify(last.styles) === JSON.stringify(styles)) last.text += buffer;
      else out.push({ text: buffer, styles });
    }
    buffer = '';
  };
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (char === '\\' && i + 1 < source.length && /[\\*_`[\]]/.test(source[i + 1])) {
      buffer += source[i + 1];
      i += 2;
    } else if (char === '`') {
      const end = source.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        buffer = source.slice(i + 1, end).replace(/ˋ/g, '`');
        flush(true);
        i = end + 1;
      } else {
        buffer += char;
        i += 1;
      }
    } else if (source.startsWith('**', i) && (bold || source.indexOf('**', i + 2) > i + 2)) {
      flush();
      bold = !bold;
      i += 2;
    } else if (char === '*' && (italic || hasSingleStar(source, i + 1))) {
      flush();
      italic = !italic;
      i += 1;
    } else if (char === '_' && (italic ? !isWordChar(source[i + 1]) : !isWordChar(source[i - 1]) && hasClosing(source, i + 1))) {
      flush();
      italic = !italic;
      i += 1;
    } else {
      buffer += char;
      i += 1;
    }
  }
  flush();
  return out;
}

/** Whether a lone `*` (not part of `**`) follows `from`, with text between. */
function hasSingleStar(source: string, from: number): boolean {
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === '\\') i += 1;
    else if (source.startsWith('**', i)) i += 1;
    else if (source[i] === '*') return i > from;
  }
  return false;
}

const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);

/** Whether an unescaped `_` that ends a word follows `from`, with text between (so snake_case stays plain). */
function hasClosing(source: string, from: number): boolean {
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === '\\') i += 1;
    else if (source[i] === '_' && i > from && !isWordChar(source[i + 1])) return true;
  }
  return false;
}

const LINK = /\[((?:\\.|[^\]\\])*)\]\(((?:https?|ipfs|mailto):[^)\s]+)\)/g;
/** A code span as `parseStyled` reads one: an unescaped backtick to the next, with text between. */
const CODE_SPAN = /(?<!\\)`[^`]+`/g;

/** Markup text as BlockNote inline content. */
export function fromMarkup(markup: string): InlineItem[] {
  const items: InlineItem[] = [];
  // Link syntax inside a code span is code text, not a link.
  const codeSpans = [...markup.matchAll(CODE_SPAN)].map((span) => [span.index ?? 0, (span.index ?? 0) + span[0].length] as const);
  const inCode = (at: number) => codeSpans.some(([from, to]) => at >= from && at < to);
  let last = 0;
  for (const match of markup.matchAll(LINK)) {
    const start = match.index ?? 0;
    if (start < last || inCode(start)) continue;
    items.push(...parseStyled(markup.slice(last, start)).map((run) => ({ type: 'text' as const, ...run })));
    const content = parseStyled(match[1]).map((run) => ({ type: 'text' as const, ...run }));
    if (content.length > 0) items.push({ type: 'link', href: match[2].replace(/%29/g, ')'), content });
    last = start + match[0].length;
  }
  items.push(...parseStyled(markup.slice(last)).map((run) => ({ type: 'text' as const, ...run })));
  return items;
}

/** Wraps the selection in `marker` (the toolbar's Bold, Italic, Code). */
export function wrapSelection(text: string, selection: { start: number; end: number }, before: string, after = before): { text: string; selection: { start: number; end: number } } {
  const { start, end } = selection;
  const next = `${text.slice(0, start)}${before}${text.slice(start, end)}${after}${text.slice(end)}`;
  return { text: next, selection: { start: start + before.length, end: end + before.length } };
}
