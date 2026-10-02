import { router, Stack } from 'expo-router';
import { Pressable, View } from 'react-native';
import { ChevronRightIcon, LockClosedIcon } from 'react-native-heroicons/outline';

import { useSession } from '~/data/session';
import { AccountList } from '~/features/auth/AccountSwitcher';
import { useAppLockSettings } from '~/features/auth/app-lock';
import { copy } from '~/features/auth/copy';
import { networkName } from '~/features/auth/onboarding';
import { cn } from '~/lib-allowlist';
import { Screen } from '~/ui/Screen';
import { Text } from '~/ui/Text';
import { tw, useColors } from '~/ui/tokens';

/**
 * Settings → Account → Accounts (UX_SPEC §4.26, PRD AUTH-10, AUTH-11): the
 * identities signed in on this device for this network, switch, add, and
 * sign out from each row's menu; and the app lock setting.
 */
export default function AccountsSettingsScreen() {
  const c = useColors();
  const { accounts } = useSession();
  const lockOn = useAppLockSettings((s) => s.enabled);
  return (
    <Screen scroll>
      <Stack.Screen options={{ title: copy.accounts.title }} />
      <Text variant="captionStrong" tone="secondary" className="px-4 pb-2 pt-6 uppercase tracking-wide">
        {networkName}
      </Text>
      <View className={cn('border-y', tw.border)} testID="accounts-list">
        <AccountList accounts={accounts} manage />
      </View>
      {accounts.length === 0 ? (
        <Text variant="subhead" tone="secondary" className="px-4 pt-3">
          {copy.accounts.empty}
        </Text>
      ) : null}
      {/* Settings → Account links here too (S10); this keeps app lock reachable from the account screens. */}
      <Text variant="captionStrong" tone="secondary" className="px-4 pb-2 pt-8 uppercase tracking-wide">
        {copy.lock.section}
      </Text>
      <View className={cn('border-y', tw.border)}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.lock.settingsTitle}
          onPress={() => router.push('/settings/app-lock')}
          testID="accounts-app-lock"
          className={cn('min-h-14 flex-row items-center gap-3 px-4 py-3', tw.pressed)}
        >
          <LockClosedIcon size={20} color={c.textSecondary} />
          <Text variant="body" className="flex-1">
            {copy.lock.settingsTitle}
          </Text>
          <Text variant="subhead" tone="secondary">
            {lockOn ? 'On' : 'Off'}
          </Text>
          <ChevronRightIcon size={16} color={c.textSecondary} />
        </Pressable>
      </View>
    </Screen>
  );
}
