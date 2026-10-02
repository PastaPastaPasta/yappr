import { Pressable, View } from 'react-native';
import { PhotoIcon, PlusCircleIcon, WifiIcon } from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';
import { IconButton } from '~/ui/IconButton';
import { Text } from '~/ui/Text';
import { hitSlopFor, tw, useColors } from '~/ui/tokens';

import { characterCount, counterLabel, counterTone, type ContentLimits } from './limits';

export interface ComposeAccessoryBarProps {
  /** The active part's text, for the counter. */
  text: string;
  limits: ContentLimits;
  offline: boolean;
  /** "Add to thread" is offered (not in reply or quote, under 10 parts). */
  canAddPart: boolean;
  onAddPart: () => void;
  mediaOpen: boolean;
  onToggleMedia: () => void;
  bottomInset: number;
}

/**
 * The bar above the keyboard (UX_SPEC §2.12): "Add to thread" (or "You're
 * offline"), the image-URL toggle, and the active part's counter: gray,
 * amber at 50 or fewer left, red when over.
 */
export function ComposeAccessoryBar({
  text,
  limits,
  offline,
  canAddPart,
  onAddPart,
  mediaOpen,
  onToggleMedia,
  bottomInset,
}: ComposeAccessoryBarProps) {
  const c = useColors();
  const tone = counterTone(text, limits);

  return (
    <View
      className={cn('flex-row items-center gap-2 border-t bg-white px-2 dark:bg-neutral-900', tw.border)}
      style={{ paddingBottom: bottomInset, minHeight: 48 + bottomInset }}
      testID="compose-accessory-bar"
    >
      {offline ? (
        <View className="flex-row items-center gap-1.5 px-2" accessibilityLiveRegion="polite">
          <WifiIcon size={18} color={c.warning} />
          <Text variant="subhead" tone="warning">
            You&apos;re offline
          </Text>
        </View>
      ) : canAddPart ? (
        <Pressable
          accessibilityRole="button"
          onPress={onAddPart}
          hitSlop={hitSlopFor(32)}
          className={cn('flex-row items-center gap-1.5 rounded-md px-2 py-1.5', tw.pressedMuted)}
          testID="compose-add-part"
        >
          <PlusCircleIcon size={20} color={c.link} />
          <Text variant="subheadStrong" tone="link">
            Add to thread
          </Text>
        </Pressable>
      ) : null}
      <IconButton
        icon={PhotoIcon}
        variant={mediaOpen ? 'primary' : 'default'}
        color={mediaOpen ? c.link : undefined}
        accessibilityLabel={mediaOpen ? 'Remove image URL' : 'Add image URL'}
        accessibilityState={{ expanded: mediaOpen }}
        onPress={onToggleMedia}
        testID="compose-media-toggle"
      />
      <View className="flex-1" />
      <Text
        variant="caption"
        tone={tone}
        tabular
        accessibilityLabel={counterLabel(text, limits)}
        className="px-2"
        testID="compose-counter"
      >
        {characterCount(text)}
        <Text variant="caption" tone="decorative">
          {' / '}
        </Text>
        {limits.chars}
      </Text>
    </View>
  );
}
