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
  const config = jest.requireActual('./app.config.ts').default({ config: {} });
  // Tests never depend on whether mobile/engine/dist happens to be built.
  const expoConfig = { ...config, extra: { ...config.extra, engine: null } };
  return { ...actual, __esModule: true, default: { ...actual.default, expoConfig } };
});

// The engine host's native dependencies. Nothing here talks to an engine: the
// WebView renders nothing and never says hello, so the supervisor stays in its
// handshake (tests that need an engine drive src/engine/supervisor directly).
jest.mock('react-native-webview', () => ({ WebView: require('react-native').View }));
jest.mock('@react-native-community/netinfo', () =>
  require('@react-native-community/netinfo/jest/netinfo-mock.js'),
);
jest.mock('expo-crypto', () => ({
  getRandomBytes: (n) => new Uint8Array(require('crypto').randomBytes(n)),
}));
// An in-memory Keychain, shared by every test file in a worker; tests reach it through __items.
jest.mock('expo-secure-store', () => {
  const items = new Map();
  const id = (key, options = {}) => `${options.keychainService ?? ''}:${key}`;
  return {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
    getItemAsync: async (key, options) => items.get(id(key, options)) ?? null,
    setItemAsync: async (key, value, options) => {
      if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error(`Invalid SecureStore key: ${key}`);
      items.set(id(key, options), value);
    },
    deleteItemAsync: async (key, options) => {
      items.delete(id(key, options));
    },
    __items: items,
  };
});
jest.mock('expo-file-system', () => ({
  Paths: { bundle: { uri: 'file:///bundle/' } },
  File: class {
    async text() {
      throw new Error('No engine bundle in tests');
    }
  },
}));
