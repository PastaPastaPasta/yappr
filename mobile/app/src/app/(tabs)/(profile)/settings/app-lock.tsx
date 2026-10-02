import { Stack } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { LOCK_TIMEOUTS, setAppLockEnabled, useAppLockSettings, useLockCapability, type LockTimeout } from '~/features/auth/app-lock';
import { copy } from '~/features/auth/copy';
import { cn } from '~/lib-allowlist';
import { errorFeedback } from '~/ui/haptics';
import { LoadingState } from '~/ui/LoadingState';
import { RadioGroup } from '~/ui/RadioGroup';
import { Screen } from '~/ui/Screen';
import { SwitchRow } from '~/ui/Switch';
import { Text } from '~/ui/Text';
import { tw } from '~/ui/tokens';

const TIMEOUT_OPTIONS = LOCK_TIMEOUTS.map((value) => ({ value: String(value), title: copy.lock.timeouts[value] }));

/** Settings → Account → App lock (PRD AUTH-12): the switch, then the timeout. */
export default function AppLockSettingsScreen() {
  const capability = useLockCapability();
  const enabled = useAppLockSettings((s) => s.enabled);
  const timeoutMs = useAppLockSettings((s) => s.timeoutMs);
  const [busy, setBusy] = useState(false);

  const toggle = (next: boolean) => {
    setBusy(true);
    setAppLockEnabled(next)
      .then((applied) => {
        if (!applied) errorFeedback();
      })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  return (
    <Screen scroll>
      <Stack.Screen options={{ title: copy.lock.settingsTitle }} />
      <LoadingState loading={capability === null}>
        <View className={cn('mt-6 border-y', tw.border)}>
          <SwitchRow
            label={capability?.label ?? ''}
            description={capability?.available ? copy.lock.note : copy.lock.unavailable}
            value={enabled}
            disabled={busy || (!capability?.available && !enabled)}
            onValueChange={toggle}
            testID="app-lock-switch"
          />
        </View>
        {enabled ? (
          <>
            <Text variant="captionStrong" tone="secondary" className="px-4 pb-2 pt-6 uppercase tracking-wide">
              {copy.lock.timeout}
            </Text>
            <View className={cn('border-y', tw.border)}>
              <RadioGroup
                options={TIMEOUT_OPTIONS}
                value={String(timeoutMs)}
                onChange={(value) => useAppLockSettings.setState({ timeoutMs: Number(value) as LockTimeout })}
                accessibilityLabel={copy.lock.timeout}
                testID="app-lock-timeout"
              />
            </View>
          </>
        ) : null}
      </LoadingState>
    </Screen>
  );
}
