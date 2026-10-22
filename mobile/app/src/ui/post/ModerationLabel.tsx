import { View } from 'react-native';
import { EyeSlashIcon } from 'react-native-heroicons/outline';

import { Text } from '../Text';
import { useColors } from '../tokens';
import type { CardModeration } from './types';

/**
 * The line an archival build (`NEXT_PUBLIC_MODERATION_VIEW=all`, which the
 * official apps never enable) puts above a moderated post: "Hidden · Spam ·
 * Oct 21, 2026" ("Hidden by moderators" when the reason does not resolve), and
 * "Restricted account" for a post written while its
 * author was restricted. Null for a post with neither mark.
 */
export function moderationLabelText(moderation: CardModeration): string | null {
  const parts: string[] = [];
  if (moderation.hidden) {
    // The reason is the charter's text; with none resolved the line says who hid it, never a number.
    parts.push(moderation.reason ? 'Hidden' : 'Hidden by moderators');
    if (moderation.reason) parts.push(moderation.reason);
    if (moderation.at) {
      parts.push(moderation.at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
    }
  }
  if (moderation.restricted) parts.push('Restricted account');
  return parts.length > 0 ? parts.join(' · ') : null;
}

export interface ModerationLabelProps {
  moderation: CardModeration | undefined;
  testID?: string;
}

/** The label above a moderated post's content. Not tappable; one element for screen readers. */
export function ModerationLabel({ moderation, testID = 'moderation-label' }: ModerationLabelProps) {
  const c = useColors();
  const text = moderation ? moderationLabelText(moderation) : null;
  if (!text) return null;
  return (
    <View accessible accessibilityLabel={text} testID={testID} className="mt-0.5 flex-row items-center gap-1.5">
      <EyeSlashIcon size={14} color={c.textSecondary} />
      <Text variant="subhead" tone="secondary" className="shrink italic">
        {text}
      </Text>
    </View>
  );
}
