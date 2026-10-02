import '~/global.css';

import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'nativewind';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { SignInPromptHost } from '~/data/require-auth';
import { startDataLayer } from '~/data/sync';
import { EngineHost } from '~/engine/EngineHost';
import { resolveAvatarSvg, useIpfsGateway, useUnsupportedEngineRoute } from '~/engine/hooks';
import { useAppearance } from '~/state/appearance';
import { ActionSheetHost } from '~/ui/action-sheet';
import { AvatarSvgProvider } from '~/ui/avatar-svg';
import { MediaUrlProvider } from '~/ui/media-url';
import { ToastHost } from '~/ui/ToastHost';
import { persistOptions, queryClient } from '~/state/query-client';
import { stackScreenOptions } from '~/ui/stack-options';
import { navigationTheme } from '~/ui/tokens';

/** Deep links into a modal or a tab still have the tabs underneath. */
export const unstable_settings = { anchor: '(tabs)' };

SplashScreen.preventAutoHideAsync().catch(() => {
  // Already hidden (fast refresh); nothing to keep up.
});

/**
 * Full-screen root modals. Not `fullScreenModal`: on iOS that presents with
 * UIModalPresentationFullScreen, which takes the presenting view, and with it
 * the engine's hidden WebView, out of the window, and WebKit then all but
 * stops a WebView that is not in a window (the engine took 20 to 30 s to load
 * behind one). `transparentModal` (over full screen) keeps it in the window;
 * the screens paint their own opaque background.
 */
const FULL_SCREEN = {
  presentation: 'transparentModal',
  animation: 'slide_from_bottom',
} as const;

/** Upper bound on holding the splash for the theme, in case no Appearance event arrives. */
const SPLASH_MAX_HOLD_MS = 1000;

/**
 * Keeps the splash up until a persisted Light/Dark override has reached
 * NativeWind. The override is applied while the store loads, but NativeWind
 * only sees it on the next Appearance event, so without this a dark override
 * on a light system would paint one light frame.
 */
function useSplashUntilThemeSettles(): void {
  const theme = useAppearance((s) => s.theme);
  const { colorScheme } = useColorScheme();
  const settled = theme === 'system' || colorScheme === theme;

  useEffect(() => {
    const hide = () => {
      SplashScreen.hideAsync().catch(() => {
        // Already hidden.
      });
    };
    if (settled) {
      hide();
      return undefined;
    }
    const timer = setTimeout(hide, SPLASH_MAX_HOLD_MS);
    return () => clearTimeout(timer);
  }, [settled]);
}

export default function RootLayout() {
  useSplashUntilThemeSettles();
  useUnsupportedEngineRoute();
  // The session store, write tickets and created content follow the engine app-wide.
  useEffect(() => startDataLayer(), []);
  const ipfsGateway = useIpfsGateway();
  const dark = useColorScheme().colorScheme === 'dark';

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
        <ThemeProvider value={navigationTheme(dark)}>
          <MediaUrlProvider ipfsGateway={ipfsGateway}>
            <AvatarSvgProvider resolve={resolveAvatarSvg}>
              <BottomSheetModalProvider>
                <Stack screenOptions={stackScreenOptions}>
                  <Stack.Screen name="(tabs)" options={{ headerShown: false }} />

                  {/* Root modals (UX_SPEC §3.2). Titles come from the screens. */}
                  <Stack.Screen name="compose" options={FULL_SCREEN} />
                  <Stack.Screen
                    name="sign-in"
                    options={{ presentation: 'modal', headerShown: false }}
                  />
                  <Stack.Screen name="profile/edit" options={{ presentation: 'modal' }} />
                  <Stack.Screen name="messages/new" options={{ presentation: 'modal' }} />
                  <Stack.Screen name="messages/new-group" options={{ presentation: 'modal' }} />
                  <Stack.Screen name="block/[userId]" options={{ presentation: 'modal' }} />
                  <Stack.Screen name="report/[postId]" options={{ presentation: 'modal' }} />
                  <Stack.Screen
                    name="media"
                    options={{
                      presentation: 'transparentModal',
                      headerShown: false,
                    }}
                  />
                  <Stack.Screen name="welcome" options={{ ...FULL_SCREEN, headerShown: false }} />
                  <Stack.Screen
                    name="terms-gate"
                    options={{ ...FULL_SCREEN, gestureEnabled: false }}
                  />
                  <Stack.Screen
                    name="lockdown"
                    options={{
                      ...FULL_SCREEN,
                      gestureEnabled: false,
                      headerShown: false,
                    }}
                  />
                  <Stack.Screen
                    name="webview-update"
                    options={{
                      ...FULL_SCREEN,
                      gestureEnabled: false,
                      headerShown: false,
                    }}
                  />

                  <Stack.Protected guard={__DEV__}>
                    <Stack.Screen name="__gallery" />
                  </Stack.Protected>
                </Stack>
                {/* The engine's hidden WebView: one per app, never unmounted (ENGINE.md §1). */}
                <EngineHost />
                <SignInPromptHost />
                <ActionSheetHost />
                <ToastHost />
                <StatusBar style="auto" />
              </BottomSheetModalProvider>
            </AvatarSvgProvider>
          </MediaUrlProvider>
        </ThemeProvider>
      </PersistQueryClientProvider>
    </GestureHandlerRootView>
  );
}
