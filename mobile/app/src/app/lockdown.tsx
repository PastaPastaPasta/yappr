import { Linking, View } from 'react-native';
import { ShieldExclamationIcon } from 'react-native-heroicons/outline';

import { EngineUnavailableScreen } from '~/engine/ui';
import { Text } from '~/ui/Text';
import { colors } from '~/ui/tokens';

const STEPS = ['Open Settings', 'Privacy & Security', 'Lockdown Mode', 'Configure Web Browsing', 'Turn Yappr off'];

/** UX_SPEC §4.33, ENGINE.md §11.4: iOS Lockdown Mode turns off WebAssembly, which the engine needs. */
export default function LockdownScreen() {
  return (
    <EngineUnavailableScreen
      icon={<ShieldExclamationIcon size={64} color={colors.yappr500} />}
      title="Lockdown Mode is blocking Yappr"
      body="Yappr needs WebAssembly to verify Dash Platform data, and Lockdown Mode turns it off for apps. You can exclude Yappr:"
      action={{
        label: 'Open Settings',
        onPress: () => {
          Linking.openSettings().catch(() => undefined);
        },
      }}
    >
      <View className="gap-1 self-stretch px-4">
        {STEPS.map((step, index) => (
          <Text key={step}>{`${index + 1}. ${step}`}</Text>
        ))}
      </View>
    </EngineUnavailableScreen>
  );
}
