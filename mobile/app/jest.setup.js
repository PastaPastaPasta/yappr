// Native-module mocks for Jest.
require('react-native-gesture-handler/jestSetup');
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
// Reanimated's mock leaves out useReducedMotion ("ADD ME IF NEEDED"). Patched
// on the mock module itself, because expo-router/testing-library re-mocks
// Reanimated with that same module.
require('react-native-reanimated/mock').useReducedMotion = () => false;
// Nor the CSS-animation easing builders; animations never run under Jest, so a description will do.
require('react-native-reanimated/mock').cubicBezier = (x1, y1, x2, y2) => ({
  toString: () => `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`,
  normalize: () => ({ x1, y1, x2, y2 }),
});
jest.mock('@gorhom/bottom-sheet', () => require('@gorhom/bottom-sheet/mock'));
// React Native's TextInput mock stubs clear(). The app empties its uncontrolled inputs in place
// (src/ui/native-text.ts), so the stub empties the text Testing Library shows for that input, as the
// native field empties (a typed text lives in Testing Library's simulated native state).
{
  const { TextInput } = require('react-native');
  const { nativeState } = require('@testing-library/react-native/build/native-state');
  TextInput.prototype.clear = jest.fn(function clear() {
    const { screen } = require('@testing-library/react-native');
    const [own] = screen.UNSAFE_root.findAll((node) => node.instance === this);
    const host = own?.children.find((child) => typeof child !== 'string' && child.type === 'TextInput');
    if (host) nativeState.valueForElement.set(host, '');
  });
}
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
jest.mock('react-native-webview', () => {
  const React = require('react');
  // Renders and loads nothing, and drops what the host injects.
  const WebView = React.forwardRef(function WebView(_props, ref) {
    React.useImperativeHandle(ref, () => ({ injectJavaScript: () => {} }));
    return null;
  });
  return { WebView };
});
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
// FLAG_SECURE on Android, expo-screen-capture on iOS. Tests read `isCaptureBlocked()` and the call log.
jest.mock('./modules/secure-window', () => {
  let blocked = false;
  let switcher = false;
  return {
    setCaptureBlocked: jest.fn(async (on) => {
      blocked = on;
      return true;
    }),
    isCaptureBlocked: () => blocked,
    setSwitcherProtected: jest.fn(async (on) => {
      switcher = on;
      return true;
    }),
    isSwitcherProtected: () => switcher,
  };
});
jest.mock('expo-file-system', () => ({
  Paths: { bundle: { uri: 'file:///bundle/' } },
  // The app bundle's engine page is there; nothing reads files in tests.
  File: class {
    exists = true;
  },
}));
// MMKV instances persist by id, as on a device, so "relaunch" and "reinstall" can be simulated
// (react-native-mmkv's own test mock is a fresh, empty instance on every call).
jest.mock('react-native-mmkv', () => {
  const actual = jest.requireActual('react-native-mmkv');
  const instances = new Map();
  return {
    ...actual,
    createMMKV: (config = {}) => {
      const id = config.id ?? 'mmkv.default';
      if (!instances.has(id)) instances.set(id, actual.createMMKV(config));
      return instances.get(id);
    },
    deleteMMKV: (id) => {
      instances.get(id)?.clearAll();
      return instances.delete(id);
    },
  };
});
