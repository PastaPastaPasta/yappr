import type { ConversationDTO } from '@engine/api';
import { View } from 'react-native';
import { UserGroupIcon } from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';
import { Avatar, type AvatarSize } from '~/ui/Avatar';
import { tw, useColors } from '~/ui/tokens';

const SIZES: Record<AvatarSize, number> = { xs: 24, sm: 32, md: 40, lg: 48, xl: 64, profile: 88 };

/** A 1:1 peer's avatar, or the group glyph on `bg.muted` (web `UserGroupIcon`). */
export function ConversationAvatar({
  conversation,
  size = 'md',
}: {
  conversation: Pick<ConversationDTO, 'kind' | 'peer'>;
  size?: AvatarSize;
}) {
  const c = useColors();
  if (conversation.kind === 'direct' && conversation.peer) {
    return <Avatar avatar={conversation.peer.avatar} identityId={conversation.peer.id} size={size} />;
  }
  const diameter = SIZES[size];
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={cn('items-center justify-center rounded-full', tw.bgMuted)}
      style={{ width: diameter, height: diameter }}
      testID="group-avatar"
    >
      <UserGroupIcon size={Math.round(diameter / 2)} color={c.textSecondary} />
    </View>
  );
}
