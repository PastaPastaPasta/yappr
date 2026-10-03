import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Text as RNText, View, type TextLayoutEvent } from 'react-native';

import {
  cashtagDisplayToStorage,
  cn,
  hashtagDisplayToStorage,
  isEmojiOnly,
  normalizeDpnsUsername,
} from '~/lib-allowlist';

import { useMediaUrls } from '../media-url';
import { Text } from '../Text';
import { monoFont, tones } from '../tokens';
import { blockLineCaps, directionRuns, directionStyle, type Direction } from './direction';
import { displayText, lineText, parseContent, splitLines, splitUrl, type ContentPart, type InlinePart } from './parse';

export interface RichTextHandlers {
  /** The DPNS label, normalized (lowercase, no `.dash`). */
  onMentionPress?: (username: string) => void;
  /** The tag in storage form (`#Dash` → `dash`), the hashtag page's key. */
  onHashtagPress?: (tag: string) => void;
  /** The cashtag in storage form (`$DASH` → `dash_cashtag`). */
  onCashtagPress?: (tag: string) => void;
  onLinkPress?: (url: string) => void;
}

export interface RichTextProps extends RichTextHandlers {
  text: string;
  variant?: 'body' | 'bodyLarge' | 'subhead';
  numberOfLines?: number;
  /**
   * Leave the first URL out (keeping its trailing punctuation): the card
   * below shows it as a link preview or quote, as web does.
   */
  hideFirstUrl?: boolean;
  /** The contract's tag ceiling (engine capabilities), so a long tag opens the page it was indexed under. */
  tagMaxLength?: number;
  /** The rendered line count, every paragraph included, once laid out. */
  onLineCount?: (lines: number) => void;
  testID?: string;
}

/** Same-direction paragraphs, rendered as one <Text>. */
interface Block {
  direction: Direction | null;
  parts: ContentPart[];
}

const LINE_BREAK: ContentPart = { type: 'text', value: '\n' };

/** The text's paragraphs grouped into runs of one direction (PRD G-9). */
function paragraphBlocks(parts: ContentPart[]): Block[] {
  const lines = splitLines(parts);
  return directionRuns(lines.map(lineText)).map(({ direction, start, end }) => ({
    direction,
    parts: lines.slice(start, end).flatMap((line, i) => (i === 0 ? line : [LINE_BREAK, ...line])),
  }));
}

/** The lines the shown blocks take, once every one is laid out. */
function laidOutLines(measured: readonly (number | undefined)[], caps: readonly (number | undefined)[]) {
  let total = 0;
  for (const [i, cap] of caps.entries()) {
    if (cap === 0) continue;
    const lines = measured[i];
    if (lines === undefined) return undefined;
    total += Math.min(lines, cap ?? lines);
  }
  return total;
}

/** Each block's laid-out line count, for this text only (a recycled cell starts over). */
function useBlockLines(text: string) {
  const [state, setState] = useState<{ text: string; lines: (number | undefined)[] }>({ text, lines: [] });
  const lines = state.text === text ? state.lines : [];
  const record = (index: number, count: number) =>
    setState((prev) => {
      const current = prev.text === text ? prev.lines : [];
      if (current[index] === count) return prev;
      const next = [...current];
      next[index] = count;
      return { text, lines: next };
    });
  return [lines, record] as const;
}

/** A tappable span in `link` color, underlined while pressed (UX_SPEC G-9). */
function LinkSpan({ children, onPress }: { children: ReactNode; onPress?: () => void }) {
  const [pressed, setPressed] = useState(false);
  return (
    // A bare RN Text, so the span inherits the paragraph's size and sets only its color.
    <RNText
      className={pressed ? cn(tones.link, 'underline') : tones.link}
      accessibilityRole="link"
      suppressHighlighting
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
    >
      {children}
    </RNText>
  );
}

/**
 * Post text with web's highlighting (components/post/post-content.tsx):
 * mentions, hashtags, cashtags and links in `link` color and tappable,
 * `**bold**`, `*italic*` and `` `code` ``. Emoji-only posts render large.
 * Each paragraph takes the direction of its first strong character (PRD
 * G-9), so Arabic and Hebrew paragraphs align right: one <Text> per run of
 * same-direction paragraphs, because a <Text> has one alignment.
 */
export const RichText = memo(function RichText({
  text,
  variant = 'body',
  numberOfLines,
  hideFirstUrl = false,
  tagMaxLength,
  onMentionPress,
  onHashtagPress,
  onCashtagPress,
  onLinkPress,
  onLineCount,
  testID,
}: RichTextProps) {
  const urls = useMediaUrls();
  // As web: strip the previewed URL from the raw text, then parse and size what is left.
  const shown = useMemo(() => displayText(text, hideFirstUrl), [text, hideFirstUrl]);
  const blocks = useMemo(() => paragraphBlocks(parseContent(shown)), [shown]);
  const emojiOnly = useMemo(() => isEmojiOnly(shown), [shown]);
  const [blockLines, recordLines] = useBlockLines(shown);
  // RN's numberOfLines 0 means no limit.
  const caps = blockLineCaps(blockLines, blocks.length, numberOfLines || undefined);
  // Laid-out line counts matter only to fit several blocks in `numberOfLines`, or to report them.
  const measure = onLineCount !== undefined || (caps[0] !== undefined && blocks.length > 1);

  const lineCount = laidOutLines(blockLines, caps);
  useEffect(() => {
    if (lineCount !== undefined) onLineCount?.(lineCount);
  }, [lineCount, onLineCount]);

  const inline = (part: InlinePart, key: string | number): ReactNode => {
    switch (part.type) {
      case 'url': {
        const { href, display, trailing } = splitUrl(part.value);
        // Only http(s) leaves the app; ipfs:// opens through the gateway.
        const target = urls.external(href);
        return [
          <LinkSpan key={key} onPress={onLinkPress && target ? () => onLinkPress(target) : undefined}>
            {display}
          </LinkSpan>,
          trailing,
        ];
      }
      case 'hashtag':
        return (
          <LinkSpan
            key={key}
            onPress={
              onHashtagPress && (() => onHashtagPress(hashtagDisplayToStorage(part.value, tagMaxLength)))
            }
          >
            {part.value}
          </LinkSpan>
        );
      case 'cashtag':
        return (
          <LinkSpan
            key={key}
            onPress={
              onCashtagPress && (() => onCashtagPress(cashtagDisplayToStorage(part.value, tagMaxLength)))
            }
          >
            {`$${part.value.slice(1).toUpperCase()}`}
          </LinkSpan>
        );
      case 'mention':
        return (
          <LinkSpan
            key={key}
            onPress={onMentionPress && (() => onMentionPress(normalizeDpnsUsername(part.value.slice(1))))}
          >
            {part.value}
          </LinkSpan>
        );
      default:
        return part.value;
    }
  };

  const content = (parts: ContentPart[]) =>
    parts.map((part, i) => {
      if ('children' in part) {
        return (
          <Text key={i} variant={variant} className={part.type === 'bold' ? 'font-bold' : 'italic'}>
            {part.children.map((child, j) => inline(child, `${i}.${j}`))}
          </Text>
        );
      }
      if (part.type === 'code') {
        return (
          // The `code` token (UX_SPEC §1.2): pink darkened to 700 for AA in light mode.
          <RNText
            key={i}
            className="bg-gray-100 text-pink-700 dark:bg-gray-800 dark:text-pink-400"
            style={[monoFont, { fontSize: 14 }]}
          >
            {part.value}
          </RNText>
        );
      }
      return inline(part, i);
    });

  const rendered = blocks.flatMap((block, i) => {
    const cap = caps[i];
    if (cap === 0) return [];
    return [
      <Text
        key={i}
        variant={variant}
        className={emojiOnly ? 'text-4xl leading-snug' : undefined}
        numberOfLines={cap}
        onTextLayout={measure ? (e: TextLayoutEvent) => recordLines(i, e.nativeEvent.lines.length) : undefined}
        style={directionStyle(block.direction)}
        testID={blocks.length === 1 ? testID : undefined}
      >
        {content(block.parts)}
      </Text>,
    ];
  });
  return blocks.length === 1 ? (rendered[0] ?? null) : <View testID={testID}>{rendered}</View>;
});
