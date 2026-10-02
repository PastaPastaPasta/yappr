import { Stack } from 'expo-router';
import { View } from 'react-native';

import { cn } from '~/lib-allowlist';
import { ErrorState } from '~/ui/EmptyState';
import { Screen } from '~/ui/Screen';
import { SwitchRow } from '~/ui/Switch';
import { Text } from '~/ui/Text';
import { tw } from '~/ui/tokens';

import { TOGGLES } from './notification-model';
import { setNotificationToggle, useSettings } from './notifications-data';

/**
 * Settings → Notifications (UX_SPEC §4.27, PRD NOTIF-05 / SET-03): one
 * switch per type, all on by default. Device-wide, so they survive sign-out
 * and account switches (PD-12). Turning one off hides its items from the
 * list and the badge at once.
 */
export function NotificationSettingsScreen() {
  const settings = useSettings();
  const toggles = settings.data?.notificationSettings;

  return (
    <Screen scroll>
      <Stack.Screen options={{ title: 'Notifications' }} />
      {settings.isError && !toggles ? (
        <ErrorState
          onRetry={() => {
            settings.refetch().catch(() => undefined);
          }}
          testID="notification-settings-error"
        />
      ) : (
        <View className="pb-8">
          <View className="gap-1 px-4 pb-2 pt-6">
            <Text variant="subheadStrong" tone="secondary" accessibilityRole="header">
              In-app notifications
            </Text>
            <Text variant="subhead" tone="secondary">
              Yappr checks for new activity while the app is open.
            </Text>
          </View>
          <View className={cn('border-y', tw.border)}>
            {TOGGLES.map((toggle, index) => (
              <View key={toggle.key} className={cn(index > 0 && 'border-t', tw.border)}>
                <SwitchRow
                  label={toggle.label}
                  description={toggle.description}
                  // All on by default, and while the engine answers.
                  value={toggles?.[toggle.key] ?? true}
                  disabled={!toggles}
                  onValueChange={(value) => {
                    setNotificationToggle(toggle.key, value).catch(() => undefined);
                  }}
                  testID={`notification-toggle-${toggle.key}`}
                />
              </View>
            ))}
          </View>
        </View>
      )}
    </Screen>
  );
}
