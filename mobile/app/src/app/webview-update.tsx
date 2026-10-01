import { Linking } from 'react-native';
import { ArrowPathIcon } from 'react-native-heroicons/outline';

import { useEngineStatus } from '~/engine/hooks';
import { EngineUnavailableScreen } from '~/engine/ui';
import { colors } from '~/ui/tokens';

const WEBVIEW_PACKAGE = 'com.google.android.webview';

const openStore = () => {
  Linking.openURL(`market://details?id=${WEBVIEW_PACKAGE}`).catch(() =>
    Linking.openURL(`https://play.google.com/store/apps/details?id=${WEBVIEW_PACKAGE}`).catch(() => undefined),
  );
};

/**
 * ENGINE.md §2.4: the engine runs in Android System WebView, and the bundle
 * targets Chrome 110. An older WebView (or one without WebAssembly) gets this
 * screen instead of a boot that cannot work.
 */
export default function WebViewUpdateScreen() {
  const { caps } = useEngineStatus();
  const version = caps?.chromeMajor ? ` (version ${caps.chromeMajor})` : '';
  return (
    <EngineUnavailableScreen
      icon={<ArrowPathIcon size={64} color={colors.yappr500} />}
      title="Update Android System WebView"
      body={`Yappr connects to Dash Platform through Android System WebView, and the one on this device${version} is too old. Update it from Google Play, then try again.`}
      action={{ label: 'Open Google Play', onPress: openStore }}
    />
  );
}
