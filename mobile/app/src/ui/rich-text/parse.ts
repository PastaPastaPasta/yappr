/**
 * Post text → parts, ported from the web's `PostContent` parser
 * (components/post/post-content.tsx) so mobile highlights exactly what web
 * links: **bold**, *italic*, `code`, URLs, #hashtags, $cashtags and
 * @mentions. Bold and italic parse their inside for the inline kinds; code
 * is literal. Overlaps keep the earliest match. The patterns are ASCII-only,
 * so emoji and RTL text pass through as plain text, never split.
 *
 * One difference from web: a tag is its whole `[a-zA-Z0-9_]` run, as the
 * compose editor reads it (features/compose/text.ts uses these patterns), so
 * a tag longer than the contract indexes is linked whole, never cut
 * mid-word. Its link opens the page the tag was indexed under: the first
 * `tagMaxLength` characters (lib `firstHashtag` / `extractHashtags`).
 */

export type InlineKind = 'text' | 'url' | 'hashtag' | 'cashtag' | 'mention';
export type PartKind = InlineKind | 'bold' | 'italic' | 'code';

export interface InlinePart {
  type: InlineKind;
  value: string;
}

export type ContentPart =
  | InlinePart
  | { type: 'bold' | 'italic'; value: string; children: InlinePart[] }
  | { type: 'code'; value: string };

interface Pattern {
  regex: RegExp;
  type: PartKind;
}

/** The tappable kinds, shared with the compose editor's highlighting. */
export const INLINE_PATTERNS: { regex: RegExp; type: Exclude<InlineKind, 'text'> }[] = [
  // http(s)://, ipfs:// or www.
  { regex: /(https?:\/\/[^\s<>"']+|ipfs:\/\/[^\s<>"']+|www\.[^\s<>"']+)/g, type: 'url' },
  // Unbounded, as compose reads them: an over-long tag is linked whole.
  { regex: /#([a-zA-Z0-9_]+)/g, type: 'hashtag' },
  { regex: /\$([a-zA-Z][a-zA-Z0-9_]*)/g, type: 'cashtag' },
  // Hyphens included, as DPNS labels (and mention indexing) allow them.
  { regex: /@([a-zA-Z0-9_-]{1,100}(?:\.dash)?)/gi, type: 'mention' },
];

const ALL_PATTERNS: Pattern[] = [
  { regex: /\*\*([^*]+)\*\*/g, type: 'bold' },
  { regex: /(?<!\*)\*([^*]+)\*(?!\*)/g, type: 'italic' },
  { regex: /`([^`]+)`/g, type: 'code' },
  ...INLINE_PATTERNS,
];

interface Match {
  type: PartKind;
  start: number;
  end: number;
  full: string;
  inner: string;
}

/** Every pattern's matches, sorted, with overlaps dropped (the earliest wins). */
function matchAll(text: string, patterns: Pattern[]): Match[] {
  const matches: Match[] = [];
  for (const { regex, type } of patterns) {
    const re = new RegExp(regex.source, regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      matches.push({ type, start: m.index, end: m.index + m[0].length, full: m[0], inner: m[1] || m[0] });
    }
  }
  matches.sort((a, b) => a.start - b.start);
  const kept: Match[] = [];
  let lastEnd = 0;
  for (const match of matches) {
    if (match.start >= lastEnd) {
      kept.push(match);
      lastEnd = match.end;
    }
  }
  return kept;
}

function parseInline(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let index = 0;
  for (const match of matchAll(text, INLINE_PATTERNS)) {
    if (match.start > index) parts.push({ type: 'text', value: text.slice(index, match.start) });
    parts.push({ type: match.type as InlineKind, value: match.full });
    index = match.end;
  }
  if (index < text.length) parts.push({ type: 'text', value: text.slice(index) });
  return parts;
}

export function parseContent(text: string): ContentPart[] {
  const parts: ContentPart[] = [];
  let index = 0;
  for (const match of matchAll(text, ALL_PATTERNS)) {
    if (match.start > index) parts.push({ type: 'text', value: text.slice(index, match.start) });
    if (match.type === 'bold' || match.type === 'italic') {
      parts.push({ type: match.type, value: match.inner, children: parseInline(match.inner) });
    } else if (match.type === 'code') {
      parts.push({ type: 'code', value: match.inner });
    } else {
      parts.push({ type: match.type, value: match.full });
    }
    index = match.end;
  }
  if (index < text.length) parts.push({ type: 'text', value: text.slice(index) });
  return parts;
}

/**
 * The parts split at every line break, one array per line (an empty array
 * for a blank line). A bold, italic or code run that spans a break
 * continues on the next line, so joining the lines with '\n' renders the
 * same text.
 */
export function splitLines(parts: ContentPart[]): ContentPart[][] {
  const lines: ContentPart[][] = [[]];
  const push = (part: ContentPart) => lines[lines.length - 1]?.push(part);
  const eachLine = (value: string, onPiece: (piece: string) => void, onBreak: () => void) =>
    value.split('\n').forEach((piece, i) => {
      if (i > 0) onBreak();
      if (piece) onPiece(piece);
    });

  for (const part of parts) {
    if ('children' in part) {
      let children: InlinePart[] = [];
      const flush = () => {
        if (children.length > 0) push({ type: part.type, value: children.map((c) => c.value).join(''), children });
        children = [];
      };
      for (const child of part.children) {
        eachLine(
          child.value,
          (value) => children.push({ type: child.type, value }),
          () => {
            flush();
            lines.push([]);
          },
        );
      }
      flush();
    } else {
      eachLine(
        part.value,
        (value) => push({ ...part, value }),
        () => lines.push([]),
      );
    }
  }
  return lines;
}

/** A line's characters as written (bold and italic without their markers), for its direction. */
export function lineText(line: ContentPart[]): string {
  return line.map((part) => part.value).join('');
}

/** Web `stripTrailingPunctuation` (lib/link-preview/urls): drops unbalanced closing parens too. */
export function stripTrailingPunctuation(url: string): string {
  const punctuation = /[.,;:!?]+$/;
  let result = url.replace(punctuation, '');
  while (result.endsWith(')')) {
    const opens = (result.match(/\(/g) || []).length;
    const closes = (result.match(/\)/g) || []).length;
    if (closes <= opens) break;
    result = result.slice(0, -1).replace(punctuation, '');
  }
  return result;
}

/**
 * The link target and visible text of a URL part, as web renders it: `www.`
 * gains `https://`, and trailing sentence punctuation stays outside the link.
 */
export function splitUrl(value: string): { href: string; display: string; trailing: string } {
  const display = value.replace(/[.,;:!?)]+$/, '');
  const prefixed = value.toLowerCase().startsWith('www.') ? `https://${value}` : value;
  return { href: stripTrailingPunctuation(prefixed), display, trailing: value.slice(display.length) };
}

const FIRST_URL = /(https?:\/\/[^\s<>"']+|ipfs:\/\/[^\s<>"']+|www\.[^\s<>"']+)/i;

/** Web `extractFirstUrl`: the first URL in the raw text, `www.` prefixed and cleaned, or null. */
export function extractFirstUrl(content: string): string | null {
  const match = FIRST_URL.exec(content);
  if (!match) return null;
  const url = match[0].toLowerCase().startsWith('www.') ? `https://${match[0]}` : match[0];
  return stripTrailingPunctuation(url);
}

/**
 * Web `stripFirstUrlAndTrim` (lib/link-preview/urls): drops the first URL of
 * the raw text, when it is `firstUrl`, keeping its trailing punctuation, then
 * trims. Works on the raw text, so a URL inside bold or code counts too.
 */
export function stripFirstUrlAndTrim(content: string, firstUrl: string | null): string {
  if (!firstUrl) return content;
  const match = FIRST_URL.exec(content);
  if (!match) return content;
  const raw = match[0];
  const normalized = raw.toLowerCase().startsWith('www.') ? `https://${raw}` : raw;
  const clean = stripTrailingPunctuation(normalized);
  if (clean !== firstUrl) return content;
  const trailingLength = Math.min(normalized.length - clean.length, raw.length);
  const trailing = trailingLength > 0 ? raw.slice(raw.length - trailingLength) : '';
  return `${content.slice(0, match.index)}${trailing}${content.slice(match.index + raw.length)}`.trim();
}

/** Web `stripPollrPollLink`: a legacy poll post shows the poll, not its link. */
export function stripLink(content: string, url: string): string {
  return content
    .split(url)
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** The text a post shows: without the previewed first URL, as web renders it. */
export function displayText(content: string, hideFirstUrl: boolean): string {
  return hideFirstUrl ? stripFirstUrlAndTrim(content, extractFirstUrl(content)) : content;
}

/** Every tappable span (mentions, tags, links) in reading order, for screen-reader actions. */
export function inlineTargets(content: string): InlinePart[] {
  return parseContent(content).flatMap((part): InlinePart[] => {
    if ('children' in part) return part.children.filter((c) => c.type !== 'text');
    if (part.type === 'code' || part.type === 'text') return [];
    return [part];
  });
}
