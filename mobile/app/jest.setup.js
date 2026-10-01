// Native-module mocks for Jest.
require('react-native-gesture-handler/jestSetup');
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('@gorhom/bottom-sheet', () => require('@gorhom/bottom-sheet/mock'));
// react-native-mmkv swaps in an in-memory store under Jest, but still imports
// Nitro, which looks up its native TurboModule at import time.
jest.mock('react-native-nitro-modules', () => ({ NitroModules: {} }));
// The devnet build's identity; src/config.ts derives the variant from it.
jest.mock('expo-application', () => ({
  applicationId: 'pr.yap.app.dev',
  nativeApplicationVersion: '1.0.0',
}));
// Embed the real app config (default variant), as `expo export:embed` does in a build.
jest.mock('expo-constants', () => {
  const actual = jest.requireActual('expo-constants');
  const expoConfig = jest.requireActual('./app.config.ts').default({ config: {} });
  return { ...actual, __esModule: true, default: { ...actual.default, expoConfig } };
});
