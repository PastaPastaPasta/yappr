import type { AccountDTO, ProfileDTO } from '@engine/api';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { CheckIcon } from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useSessionExpired } from '~/data/session-expiry';
import { cn } from '~/lib-allowlist';
import { Avatar } from '~/ui/Avatar';
import { Button } from '~/ui/Button';
import { ScalePressable } from '~/ui/ScalePressable';
import { Text } from '~/ui/Text';
import { useRipple } from '~/ui/ripple';
import { monoFont, tw, useColors } from '~/ui/tokens';

import { accountName } from './accounts';
import { copy } from './copy';

/**
 * One signed-in account (UX_SPEC §4.26 "Accounts"): avatar, display name or
 * truncated id, @handle, a check on the current one, and "Sign
 * in again" when its stored key no longer signs (AUTH-14): a button beside
 * the row with `onSignInAgain`, else a mark in it. The profile is a cached
 * read, so the row paints from the persisted cache offline.
 */
export function AccountRow({
  account,
  onPress,
  onSignInAgain,
  trailing,
  testID,
}: {
  account: AccountDTO;
  onPress?: () => void;
  onSignInAgain?: () => void;
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
  const expired = useSessionExpired(account.identityId);
  const signInAgainId = testID ? `${testID}-sign-in-again` : undefined;

  const ripple = useRipple();
  return (
    // The menu sits beside the row, not inside it: an iOS button hides the controls it contains.
    <View className={cn('flex-row items-center', trailing || (expired && onSignInAgain) ? 'pr-2' : null)}>
      <ScalePressable
        android_ripple={ripple}
        wrapperStyle={{ flex: 1 }}
        accessibilityRole="button"
        accessibilityLabel={[
          name,
          showHandle ? handle : null,
          account.active ? 'current account' : null,
          expired ? copy.accounts.signInAgain : null,
        ]
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
          {showHandle ? (
            <Text variant="subhead" tone="secondary" numberOfLines={1}>
              {handle}
            </Text>
          ) : null}
          {expired && !onSignInAgain ? (
            <Text variant="subheadStrong" tone="error" numberOfLines={1} testID={signInAgainId}>
              {copy.accounts.signInAgain}
            </Text>
          ) : null}
        </View>
        {account.active ? <CheckIcon size={22} color={c.accent} strokeWidth={2.5} /> : null}
      </ScalePressable>
      {expired && onSignInAgain ? (
        <Button
          label={copy.accounts.signInAgain}
          variant="outline"
          size="sm"
          hitSlop={8}
          accessibilityLabel={`${copy.accounts.signInAgain}: ${handle}`}
          onPress={onSignInAgain}
          testID={signInAgainId}
        />
      ) : null}
      {trailing}
    </View>
  );
}
