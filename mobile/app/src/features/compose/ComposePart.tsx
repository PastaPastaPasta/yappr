import type { AuthorDTO } from '@engine/api';
import { forwardRef, useMemo } from 'react';
import {
  Text as RNText,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import { CheckCircleIcon, XMarkIcon } from 'react-native-heroicons/outline';

import { Avatar } from '~/ui/Avatar';
import { IconButton } from '~/ui/IconButton';
import { Text } from '~/ui/Text';
import { useColors, useIsDark } from '~/ui/tokens';

import type { DraftPart } from './drafts';
import { contentOverage, overflowOffset, type ContentLimits } from './limits';
import { composeHints, editorSpans } from './text';

export interface ComposePartProps {
  index: number;
  part: DraftPart;
  author: AuthorDTO | null;
  placeholder: string;
  limits: ContentLimits;
  tagMax: number;
  /** Dev contracts index one tag and notify one mention: show the hints (PRD COMP-06, COMP-07). */
  inlineHints: boolean;
  /** The thread line continues below the avatar. */
  joined: boolean;
  removable: boolean;
  autoFocus: boolean;
  onChangeText: (index: number, text: string) => void;
  onFocus: (index: number) => void;
  onSelection: (index: number, caret: number) => void;
  onRemove: (index: number) => void;
}

/**
 * One editor of compose (UX_SPEC §2.12): the avatar with the thread line,
 * a borderless `body.large` input whose mentions, tags and links are in the
 * link color and whose overflow has the error background, and the hints
 * under it. A part already posted (a resumed thread) is shown read-only.
 */
export const ComposePart = forwardRef<TextInput, ComposePartProps>(function ComposePart(
  {
    index,
    part,
    author,
    placeholder,
    limits,
    tagMax,
    inlineHints,
    joined,
    removable,
    autoFocus,
    onChangeText,
    onFocus,
    onSelection,
    onRemove,
  },
  ref,
) {
  const c = useColors();
  const dark = useIsDark();
  const { text } = part;
  const overflowAt = overflowOffset(text, limits);
  const spans = useMemo(() => editorSpans(text, tagMax, overflowAt), [text, tagMax, overflowAt]);
  const hints = useMemo(() => composeHints(text, tagMax), [text, tagMax]);
  const { bytesOver } = contentOverage(text, limits);
  const overBg = dark ? 'rgba(127,29,29,0.45)' : '#fee2e2';

  const onSelectionChange = (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) =>
    onSelection(index, e.nativeEvent.selection.end);

  return (
    <View className="flex-row gap-3 px-4" testID={`compose-part-${index}`}>
      <View className="items-center pt-1">
        {author ? (
          <Avatar avatar={author.avatar} identityId={author.id} size="sm" />
        ) : (
          <View className="h-8 w-8 rounded-full bg-gray-200 dark:bg-gray-800" />
        )}
        {joined ? <View className="mt-1 w-0.5 flex-1 bg-gray-200 dark:bg-gray-800" /> : null}
      </View>
      <View className="min-w-0 flex-1 pb-4">
        {part.postedId ? (
          <View accessible accessibilityLabel={`Posted: ${text}`}>
            <Text variant="bodyLarge" tone="secondary">
              {text}
            </Text>
            <View className="mt-1 flex-row items-center gap-1">
              <CheckCircleIcon size={14} color={c.repost} />
              <Text variant="caption" tone="repost">
                Posted
              </Text>
            </View>
          </View>
        ) : (
          <View className="flex-row items-start">
            <TextInput
              ref={ref}
              multiline
              autoFocus={autoFocus}
              placeholder={placeholder}
              placeholderTextColor={c.textPlaceholder}
              onChangeText={(next) => onChangeText(index, next)}
              onFocus={() => onFocus(index)}
              onSelectionChange={onSelectionChange}
              scrollEnabled={false}
              textAlignVertical="top"
              accessibilityLabel={index === 0 ? placeholder : `Thread post ${index + 1}`}
              testID={`compose-input-${index}`}
              className="min-h-12 flex-1 p-0 pt-1 text-[17px] leading-[26px]"
              style={{ color: c.textPrimary }}
            >
              {spans.map((span, i) => (
                <RNText
                  key={i}
                  style={{
                    color: span.style === 'plain' ? c.textPrimary : span.style === 'link' ? c.link : c.error,
                    textDecorationLine: span.style === 'tagTooLong' ? 'underline' : 'none',
                    backgroundColor: span.over ? overBg : undefined,
                  }}
                >
                  {span.text}
                </RNText>
              ))}
            </TextInput>
            {removable ? (
              <IconButton
                icon={XMarkIcon}
                iconSize={18}
                accessibilityLabel="Remove this post"
                onPress={() => onRemove(index)}
                testID={`compose-remove-${index}`}
              />
            ) : null}
          </View>
        )}
        {bytesOver > 0 ? (
          <Text variant="caption" tone="error" className="mt-1" testID={`compose-bytes-over-${index}`}>
            {bytesOver} bytes over the size limit. Emoji and non-Latin text count extra.
          </Text>
        ) : null}
        {hints.tagTooLong ? (
          <Text variant="caption" tone="error" className="mt-1">
            Tags can be up to {tagMax} characters
          </Text>
        ) : null}
        {inlineHints && hints.secondMention ? (
          <Text variant="caption" tone="warning" className="mt-1">
            Only the first @mention notifies the person.
          </Text>
        ) : null}
        {inlineHints && hints.secondTag ? (
          <Text variant="caption" tone="warning" className="mt-1">
            Only the first #tag puts this post on a tag page.
          </Text>
        ) : null}
      </View>
    </View>
  );
});
