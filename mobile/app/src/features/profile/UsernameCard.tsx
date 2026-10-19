import { useState } from 'react';
import { View } from 'react-native';
import { XMarkIcon } from 'react-native-heroicons/outline';

import { router } from 'expo-router';
import { cn } from '~/lib-allowlist';
import { syncStorage } from '~/state/storage';
import { Button } from '~/ui/Button';
import { IconButton } from '~/ui/IconButton';
import { Text } from '~/ui/Text';
import { tw } from '~/ui/tokens';


const dismissedKey = (identityId: string) => `yappr.usernameCard.dismissed.${identityId}`;

/** Whether this account closed the card (remembered per account, PRD AUTH-15). */
export function usernameCardDismissed(identityId: string): boolean {
  return syncStorage.getItem(dismissedKey(identityId)) === '1';
}

/**
 * "Get a username" (PRD AUTH-15, copy `username.card*`): for an account with
 * no DPNS name. Registration stays in the native app and uses the engine's DPNS service.
 */
export function UsernameCard({ identityId, className }: { identityId: string; className?: string }) {
  const [dismissed, setDismissed] = useState(() => usernameCardDismissed(identityId));
  if (dismissed) return null;
  const dismiss = () => {
    syncStorage.setItem(dismissedKey(identityId), '1');
    setDismissed(true);
  };
  return (
    <View
      className={cn('rounded-2xl border p-4', tw.border, tw.bgSelected, className)}
      testID="username-card"
      accessibilityRole="summary"
    >
      <View className="flex-row items-start gap-2">
        <View className="flex-1 gap-1">
          <Text variant="bodyStrong" tone="emphasis" accessibilityRole="header">
            Get a username
          </Text>
          <Text variant="subhead" tone="secondary">
            Usernames make you easy to find. Choose one in the app.
          </Text>
        </View>
        <IconButton
          icon={XMarkIcon}
          accessibilityLabel="Dismiss"
          onPress={dismiss}
          className="-mr-2 -mt-2"
          testID="username-card-dismiss"
        />
      </View>
      <Button
        label="Choose a username"
        size="sm"
        layoutStyle={{ alignSelf: 'flex-start', marginTop: 12 }}
        onPress={() => router.push('/settings/username')}
        testID="username-card-open"
      />
    </View>
  );
}
