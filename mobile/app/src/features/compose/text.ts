/**
 * What the compose editor reads from its text: the spans it colors
 * (PRD COMP-07, UX_SPEC §2.12), the @-fragment under the caret
 * (COMP-06) and who a post with several mentions notifies.
 *
 * The patterns are the post parser's (`ui/rich-text/parse.ts`), so the
 * editor highlights what the published post links, except a tag longer
 * than the contract indexes: that one stays plain here, with no rule to
 * read (#11), since no tag page will list the post under it.
 */

import { INLINE_PATTERNS } from '~/ui/rich-text/parse';

export type TokenKind = 'url' | 'hashtag' | 'cashtag' | 'mention';

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
  value: string;
}

const PATTERNS: { kind: TokenKind; regex: RegExp }[] = INLINE_PATTERNS.map(({ type, regex }) => ({ kind: type, regex }));

/** Every token in order; where two overlap, the earlier one wins (as web). */
export function tokenize(text: string): Token[] {
  const found: Token[] = [];
  for (const { kind, regex } of PATTERNS) {
    const re = new RegExp(regex.source, regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      found.push({ kind, start: m.index, end: m.index + m[0].length, value: m[0] });
    }
  }
  found.sort((a, b) => a.start - b.start);
  const kept: Token[] = [];
  let lastEnd = 0;
  for (const token of found) {
    if (token.start >= lastEnd) {
      kept.push(token);
      lastEnd = token.end;
    }
  }
  return kept;
}

/** The longest tag the contract indexes: 61 where tags are inline (dev), 63 elsewhere. */
export function tagMaxLength(hashtagsInline: boolean): number {
  return hashtagsInline ? 61 : 63;
}

/** A tag's length without its `#` / `$`. */
const tagLength = (token: Token) => token.value.length - 1;

export function isTagTooLong(token: Token, maxLength: number): boolean {
  return (token.kind === 'hashtag' || token.kind === 'cashtag') && tagLength(token) > maxLength;
}

export type SpanStyle = 'plain' | 'link';

export interface Span {
  text: string;
  style: SpanStyle;
  /** Past the content limit: red background. */
  over: boolean;
}

/**
 * The editor's styled runs: tokens in the link color (but a tag too long
 * to index stays plain), and everything from `overflowAt` on marked over.
 */
export function editorSpans(text: string, tagMax: number, overflowAt: number | null): Span[] {
  const runs: { start: number; end: number; style: SpanStyle }[] = [];
  let index = 0;
  for (const token of tokenize(text)) {
    if (token.start > index) runs.push({ start: index, end: token.start, style: 'plain' });
    runs.push({ start: token.start, end: token.end, style: isTagTooLong(token, tagMax) ? 'plain' : 'link' });
    index = token.end;
  }
  if (index < text.length) runs.push({ start: index, end: text.length, style: 'plain' });

  const spans: Span[] = [];
  for (const run of runs) {
    const cut = overflowAt === null ? run.end : Math.min(Math.max(overflowAt, run.start), run.end);
    if (cut > run.start) spans.push({ text: text.slice(run.start, cut), style: run.style, over: false });
    if (cut < run.end) spans.push({ text: text.slice(cut, run.end), style: run.style, over: true });
  }
  return spans;
}

export interface MentionQuery {
  /** Where the `@` is. */
  start: number;
  /** The caret. */
  end: number;
  /** The typed name, without the `@`. */
  query: string;
}

/** Suggestions open after `@` and this many characters (PRD COMP-06). */
export const MENTION_MIN_CHARS = 3;

/**
 * The `@name` fragment that ends at the caret, once it is long enough to
 * search. The `@` must start the text or follow whitespace, so an email
 * address never triggers it.
 */
export function mentionAt(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([a-zA-Z0-9_-]+)$/.exec(before);
  if (!match) return null;
  const query = match[2] ?? '';
  if (query.length < MENTION_MIN_CHARS) return null;
  return { start: caret - query.length - 1, end: caret, query };
}

/** Replaces the fragment with `@username ` and returns the text and the caret after it. */
export function insertMention(text: string, at: MentionQuery, username: string): { text: string; caret: number } {
  const inserted = `@${username} `;
  const rest = text.slice(at.end).replace(/^ /, '');
  return { text: text.slice(0, at.start) + inserted + rest, caret: at.start + inserted.length };
}

export interface ComposeHints {
  /**
   * Two or more different @mentions where only the first notifies (dev):
   * that first mention, as typed ("@alice"); otherwise null.
   */
  notified: string | null;
}

export function composeHints(text: string): ComposeHints {
  const mentions = tokenize(text).filter((t) => t.kind === 'mention');
  const distinct = new Set(mentions.map((t) => t.value.toLowerCase()));
  return { notified: distinct.size > 1 ? (mentions[0]?.value ?? null) : null };
}
