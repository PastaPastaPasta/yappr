import { memo, useMemo, useState, type ReactNode } from 'react';
import { Text as RNText, type TextLayoutEvent } from 'react-native';

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
import { displayText, parseContent, splitUrl, type InlinePart } from './parse';

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
  onTextLayout?: (e: TextLayoutEvent) => void;
  testID?: string;
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
 * The paragraph keeps the system's natural direction, so RTL posts align right.
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
  onTextLayout,
  testID,
}: RichTextProps) {
  const urls = useMediaUrls();
  // As web: strip the previewed URL from the raw text, then parse and size what is left.
  const shown = useMemo(() => displayText(text, hideFirstUrl), [text, hideFirstUrl]);
  const parts = useMemo(() => parseContent(shown), [shown]);
  const emojiOnly = useMemo(() => isEmojiOnly(shown), [shown]);

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

  return (
    <Text
      variant={variant}
      className={emojiOnly ? 'text-4xl leading-snug' : undefined}
      numberOfLines={numberOfLines}
      onTextLayout={onTextLayout}
      style={{ writingDirection: 'auto' }}
      testID={testID}
    >
      {parts.map((part, i) => {
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
      })}
    </Text>
  );
});
