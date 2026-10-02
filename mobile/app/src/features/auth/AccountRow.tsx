import type { AccountDTO, ProfileDTO } from '@engine/api';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { CheckIcon } from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { cn } from '~/lib-allowlist';
import { Avatar } from '~/ui/Avatar';
import { ScalePressable } from '~/ui/ScalePressable';
import { Text } from '~/ui/Text';
import { monoFont, tw, useColors } from '~/ui/tokens';

import { accountName } from './accounts';
import { networkName as networkLabel } from './onboarding';
import { useRipple } from '~/ui/ripple';

/**
 * One signed-in account (UX_SPEC §4.26 "Accounts"): avatar, display name or
 * truncated id, @handle and network, a check on the current one. The profile
 * is a cached read, so the row paints from the persisted cache offline.
 */
export function AccountRow({
  account,
  onPress,
  trailing,
  testID,
}: {
  account: AccountDTO;
  onPress?: () => void;
  trailing?: ReactNode;
  testID?: string;
}) {
  const c = useColors();
  const { data: profile } = useEngineQuery<ProfileDTO | null>(
    queryKeys.profile.detail(account.identityId),
    (api) => api.profiles.get(account.identityId),
    { persist: true, staleTime: 5 * 60_000 },
  );
  const handle = accountName({ identityId: account.identityId, username: profile?.username ?? account.username });
  // With neither a profile nor a name, the truncated id (AUTH-15), not lib's "User abc123".
  const name = profile && (profile.hasProfile || profile.username) ? profile.displayName : handle;
  const showHandle = name !== handle;

  const ripple = useRipple();
  return (
    // The menu sits beside the row, not inside it: an iOS button hides the controls it contains.
    <View className={cn('flex-row items-center', trailing ? 'pr-2' : null)}>
      <ScalePressable
        android_ripple={ripple}
        wrapperStyle={{ flex: 1 }}
        accessibilityRole="button"
        accessibilityLabel={[name, showHandle ? handle : null, networkLabel, account.active ? 'current account' : null]
          .filter(Boolean)
          .join(', ')}
        accessibilityState={{ selected: account.active }}
        onPress={onPress}
        disabled={!onPress}
        testID={testID}
        className={cn('min-h-[72px] flex-row items-center gap-3 px-4 py-3', tw.pressed)}
      >
        <Avatar avatar={profile?.avatar} identityId={account.identityId} size="lg" />
        <View className="flex-1 gap-0.5">
          <Text variant="bodyStrong" numberOfLines={1} style={name === handle && !account.username ? monoFont : undefined}>
            {name}
          </Text>
          <Text variant="subhead" tone="secondary" numberOfLines={1}>
            {showHandle ? `${handle} · ${networkLabel}` : networkLabel}
          </Text>
        </View>
        {account.active ? <CheckIcon size={22} color={c.accent} strokeWidth={2.5} /> : null}
      </ScalePressable>
      {trailing}
    </View>
  );
}
