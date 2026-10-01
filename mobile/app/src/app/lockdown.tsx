import { Stack } from 'expo-router';
import { Linking, View } from 'react-native';
import { ShieldExclamationIcon } from 'react-native-heroicons/outline';

import { useLeaveWhenEngineRecovers } from '~/engine/hooks';
import { engineSupervisor } from '~/engine/index';
import { ActionButton } from '~/engine/ui';
import { Screen } from '~/ui/Screen';
import { Text } from '~/ui/Text';
import { colors } from '~/ui/tokens';

const STEPS = ['Open Settings', 'Privacy & Security', 'Lockdown Mode', 'Configure Web Browsing', 'Turn Yappr off'];

/** UX_SPEC §4.33, ENGINE.md §11.4: iOS Lockdown Mode turns off WebAssembly, which the engine needs. */
export default function LockdownScreen() {
  const leave = useLeaveWhenEngineRecovers();

  return (
    <Screen scroll>
      <Stack.Screen options={{ title: 'Lockdown Mode' }} />
      <View className="flex-1 items-center gap-5 px-8 pb-12 pt-24">
        <ShieldExclamationIcon size={64} color={colors.yappr500} />
        <Text variant="title" className="text-center">
          Lockdown Mode is blocking Yappr
        </Text>
        <Text variant="muted" className="text-center text-base">
          Yappr needs WebAssembly to verify Dash Platform data, and Lockdown Mode turns it off for apps. You can
          exclude Yappr:
        </Text>
        <View className="gap-1 self-stretch px-4">
          {STEPS.map((step, index) => (
            <Text key={step}>{`${index + 1}. ${step}`}</Text>
          ))}
        </View>
        <View className="gap-3 self-stretch pt-2">
          <ActionButton
            label="Open Settings"
            onPress={() => {
              Linking.openSettings().catch(() => undefined);
            }}
          />
          <ActionButton kind="outline" label="Browse saved posts" onPress={leave} />
          <ActionButton kind="plain" label="Try again" onPress={() => engineSupervisor.restart('Try again (Lockdown)')} />
        </View>
      </View>
    </Screen>
  );
}
