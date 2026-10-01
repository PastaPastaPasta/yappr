import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { engineStorage, engineSupervisor } from './index';
import { bridgeLifecycle } from './lifecycle';
import { appendLog } from './logs';
import type { EngineLoad } from './page';

/**
 * The hidden WebView the engine runs in (ENGINE.md §1, §11.3). Mounted once,
 * by the root layout, before any screen; the supervisor remounts it with a
 * new key for every engine epoch. It is out of the visual and accessibility
 * trees, never focused and never shows content.
 */
export function EngineHost() {
  const mount = useSyncExternalStore(engineSupervisor.subscribeMount, engineSupervisor.getMount);
  const webview = useRef<WebView>(null);
  /** The epoch whose page has started loading: the engine page loads once, never again (or from the network). */
  const loadedEpoch = useRef<number | null>(null);
  const transport = mount?.transport;

  useEffect(() => {
    // Bridge first, so a background launch is known before the first start.
    const unbridge = bridgeLifecycle(engineSupervisor, engineStorage.idle);
    engineSupervisor.start();
    return () => {
      unbridge();
      engineSupervisor.stop();
    };
  }, []);

  // Hand each epoch's transport its WebView once mounted; the remount for the next epoch detaches it.
  useEffect(() => {
    transport?.attach(webview.current);
    return () => transport?.attach(null);
  }, [transport]);

  if (!mount) return null;
  const { epoch, load } = mount;
  const crashed = (cause: string) => engineSupervisor.crashed(cause, epoch);

  return (
    <View
      style={styles.hidden}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <WebView
        key={epoch}
        ref={webview}
        style={styles.hidden}
        source={load.source}
        allowFileAccess={load.allowFileAccess}
        // Everything goes through onShouldStartLoadWithRequest: react-native-webview hands a
        // non-whitelisted URL to Linking.openURL without asking, which would let the engine open apps.
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={(request) => {
          if (request.url === 'about:blank') return true;
          // Android loads the page with loadDataWithBaseURL, which never asks: any request here
          // is a navigation away from it. iOS asks once for the page itself.
          if (Platform.OS === 'android' || loadedEpoch.current === epoch || !isEnginePage(load, request.url)) {
            appendLog('warn', 'host', `Blocked a navigation to ${request.url}`);
            return false;
          }
          loadedEpoch.current = epoch;
          return true;
        }}
        onMessage={(event) => {
          const { url, data } = event.nativeEvent;
          // Android reports no URL for a page loaded with a file:// base (the APK's engine assets).
          const fromEngine = isEnginePage(load, url) || (load.pageUrl.startsWith('file:') && (!url || url === 'null'));
          if (fromEngine) mount.transport.receive(data);
          else appendLog('warn', 'host', `Ignored a message from ${url}`);
        }}
        onContentProcessDidTerminate={() => crashed('the WebContent process terminated')}
        onRenderProcessGone={(event) => crashed(`the renderer is gone (didCrash: ${event.nativeEvent.didCrash})`)}
        onError={(event) => crashed(`the page failed to load: ${event.nativeEvent.description}`)}
        javaScriptEnabled
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        allowsLinkPreview={false}
        // iOS only: the Android prop is typed differently and a string crashes Fabric there.
        dataDetectorTypes={Platform.OS === 'ios' ? 'none' : undefined}
        mediaPlaybackRequiresUserAction
        geolocationEnabled={false}
        mixedContentMode="never"
        incognito
        cacheEnabled={false}
        webviewDebuggingEnabled={__DEV__}
      />
    </View>
  );
}

/**
 * The page itself (its base URL, see ./page.ts). Nothing else may
 * load or talk to the host. Android reports the base URL without its trailing
 * slash.
 */
function isEnginePage(load: EngineLoad, url: string | undefined): boolean {
  const trim = (value: string) => value.replace(/\/$/, '');
  return url !== undefined && trim(url) === trim(load.pageUrl);
}

const styles = StyleSheet.create({
  // Zero-size and transparent: ENGINE.md O4 measures timer throttling at this size.
  hidden: { position: 'absolute', width: 0, height: 0, opacity: 0, overflow: 'hidden' },
});
