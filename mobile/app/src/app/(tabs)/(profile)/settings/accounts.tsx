import { Stack } from 'expo-router';
import { View } from 'react-native';

import { useSession } from '~/data/session';
import { AccountList } from '~/features/auth/AccountSwitcher';
import { copy } from '~/features/auth/copy';
import { networkName } from '~/features/auth/onboarding';
import { cn } from '~/lib-allowlist';
import { Screen } from '~/ui/Screen';
import { Text } from '~/ui/Text';
import { tw } from '~/ui/tokens';

/**
 * Settings → Account → Accounts (UX_SPEC §4.26, PRD AUTH-10, AUTH-11): the
 * identities signed in on this device for this network, switch, add, and
 * sign out from each row's menu.
 */
export default function AccountsSettingsScreen() {
  const { accounts } = useSession();
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
    </Screen>
  );
}
