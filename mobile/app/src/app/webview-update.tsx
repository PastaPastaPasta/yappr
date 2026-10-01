import { Stack } from 'expo-router';
import { Linking, View } from 'react-native';
import { ArrowPathIcon } from 'react-native-heroicons/outline';

import { useEngineStatus, useLeaveWhenEngineRecovers } from '~/engine/hooks';
import { engineSupervisor } from '~/engine/index';
import { ActionButton } from '~/engine/ui';
import { Screen } from '~/ui/Screen';
import { Text } from '~/ui/Text';
import { colors } from '~/ui/tokens';

const WEBVIEW_PACKAGE = 'com.google.android.webview';

/**
 * ENGINE.md §2.4: the engine runs in Android System WebView, and the bundle
 * targets Chrome 110. An older WebView (or one without WebAssembly) gets this
 * screen instead of a boot that cannot work.
 */
export default function WebViewUpdateScreen() {
  const { caps } = useEngineStatus();
  const leave = useLeaveWhenEngineRecovers();
  const version = caps?.chromeMajor ? ` (version ${caps.chromeMajor})` : '';

  const openStore = () => {
    Linking.openURL(`market://details?id=${WEBVIEW_PACKAGE}`).catch(() =>
      Linking.openURL(`https://play.google.com/store/apps/details?id=${WEBVIEW_PACKAGE}`).catch(() => undefined),
    );
  };

  return (
    <Screen scroll>
      <Stack.Screen options={{ title: 'Update WebView' }} />
      <View className="flex-1 items-center gap-5 px-8 pb-12 pt-24">
        <ArrowPathIcon size={64} color={colors.yappr500} />
        <Text variant="title" className="text-center">
          Update Android System WebView
        </Text>
        <Text variant="muted" className="text-center text-base">
          {`Yappr connects to Dash Platform through Android System WebView, and the one on this device${version} is too old. Update it from Google Play, then try again.`}
        </Text>
        <View className="gap-3 self-stretch pt-2">
          <ActionButton label="Open Google Play" onPress={openStore} />
          <ActionButton kind="outline" label="Browse saved posts" onPress={leave} />
          <ActionButton kind="plain" label="Try again" onPress={() => engineSupervisor.restart('Try again (WebView update)')} />
        </View>
      </View>
    </Screen>
  );
}
