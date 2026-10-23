// Real timers a test file leaves pending must not outlive it. App code schedules some that nothing
// cancels once the last test is done (the reconciler's 5 to 60 s rechecks, the private feed's 4 s
// re-read) and TanStack Query schedules a gcTime timer (5 minutes) for every cache entry. A worker
// that still has one fails to exit ("A worker process has failed to exit gracefully"), and a run
// in one process (a single file, or a one-CPU CI runner) waits for it. So every timer is noted
// here and whatever is still pending is cleared after the file's last test and again at teardown.
// Fake timers replace these functions while a test uses them, and never reach the clock.
{
  const pending = new Set();
  let closed = false;
  const { setTimeout: realSetTimeout, setInterval: realSetInterval, clearTimeout: realClearTimeout, clearInterval: realClearInterval } = global;
  const note = (timer) => {
    // After the environment is torn down nothing will clear it: let it go.
    if (closed) timer.unref?.();
    else pending.add(timer);
    return timer;
  };
  global.setTimeout = (callback, delay, ...args) => {
    // Node's own error for a bad callback, at the call.
    if (typeof callback !== 'function') return realSetTimeout(callback, delay, ...args);
    const timer = realSetTimeout(
      (...fired) => {
        pending.delete(timer);
        return callback(...fired);
      },
      delay,
      ...args,
    );
    return note(timer);
  };
  // `util.promisify(setTimeout)` keeps working.
  global.setTimeout[require('util').promisify.custom] = realSetTimeout[require('util').promisify.custom];
  global.setInterval = (callback, delay, ...args) => note(realSetInterval(callback, delay, ...args));
  global.clearTimeout = (timer) => {
    pending.delete(timer);
    realClearTimeout(timer);
  };
  global.clearInterval = (timer) => {
    pending.delete(timer);
    realClearInterval(timer);
  };
  const flush = () => {
    for (const timer of pending) realClearTimeout(timer);
    pending.clear();
  };
  // After the file's last test. jest.environment.js flushes again when the environment is torn down, which
  // is after every hook (a fetch that settles late schedules its gcTime then), and stops noting timers.
  afterAll(flush);
  global[Symbol.for('yappr.jest.pendingTimers')] = {
    close() {
      flush();
      closed = true;
    },
  };
}

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
// An in-memory file system. The app bundle's files (the engine page) always exist and are never read;
// the cache holds what the app writes (saved delivery files). `__fs` lets tests look inside.
jest.mock('expo-file-system', () => {
  const { createHash } = jest.requireActual('crypto');
  const BUNDLE = 'file:///bundle/';
  const files = new Map();
  const uriOf = (parts) =>
    parts
      .map((part) => (typeof part === 'string' ? part : part.uri))
      .join('/')
      .replace(/\/{2,}/g, '/')
      .replace(/^file:\//, 'file:///')
      .replace(/(.)\/$/, '$1');
  const under = (uri, prefix) => uri === prefix || uri.startsWith(`${prefix}/`);
  class File {
    constructor(...parts) {
      this.uri = uriOf(parts);
    }
    get exists() {
      return this.uri.startsWith(BUNDLE) || files.has(this.uri);
    }
    create(options = {}) {
      if (files.has(this.uri) && !options.overwrite) throw new Error(`${this.uri} exists`);
      files.set(this.uri, new Uint8Array(0));
    }
    write(content, options = {}) {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
      const before = options.append ? files.get(this.uri) ?? new Uint8Array(0) : new Uint8Array(0);
      const next = new Uint8Array(before.length + bytes.length);
      next.set(before);
      next.set(bytes, before.length);
      files.set(this.uri, next);
    }
    get size() {
      return files.get(this.uri)?.length ?? 0;
    }
    get md5() {
      const bytes = files.get(this.uri);
      return bytes ? createHash('md5').update(bytes).digest('hex') : null;
    }
    delete() {
      if (!files.delete(this.uri)) throw new Error(`${this.uri} does not exist`);
    }
  }
  class Directory {
    constructor(...parts) {
      this.uri = uriOf(parts);
    }
    // A folder exists while it holds a file; creating one is a no-op.
    get exists() {
      return [...files.keys()].some((uri) => under(uri, this.uri));
    }
    create() {}
    delete() {
      for (const uri of [...files.keys()]) if (under(uri, this.uri)) files.delete(uri);
    }
  }
  return {
    Paths: { bundle: { uri: BUNDLE }, cache: new Directory('file:///cache') },
    File,
    Directory,
    __fs: { files },
  };
});
// MMKV files persist by id, as on a device, and outlive the process (react-native-mmkv's own test
// mock is a fresh, empty instance on every call). `__relaunch()` starts a new process: what it
// opened is forgotten (a module loaded afresh with `jest.isolateModules` then has its own state,
// though Jest hands it this same mock). `__uninstall()` also drops the files (Keychain items stay).
//
// Each file has a key. Opening one this process has not opened with another key reads it empty
// (MMKV can't decrypt it and starts over); one already open is the instance native caches, key and
// all; `encrypt` re-keys it. And on a device `deleteMMKV(id)` frees the native store under every
// instance of `id` this process created, which react-native-mmkv calls again when the app becomes
// active: deleting one the app opened crashes it (D-902), so here it throws.
jest.mock('react-native-mmkv', () => {
  const actual = jest.requireActual('react-native-mmkv');
  const files = new Map();
  let opened = new Set();
  return {
    ...actual,
    createMMKV: (config = {}) => {
      const id = config.id ?? 'mmkv.default';
      const key = config.encryptionKey ?? null;
      let file = files.get(id);
      if (!file) {
        file = { store: actual.createMMKV(config), key };
        file.store.encrypt = (newKey) => {
          file.key = newKey;
        };
        files.set(id, file);
      } else if (!opened.has(id) && file.key !== key) {
        file.store.clearAll();
        file.key = key;
      }
      opened.add(id);
      return file.store;
    },
    deleteMMKV: (id) => {
      if (opened.has(id)) throw new Error(`deleteMMKV('${id}') frees an instance this process still holds`);
      files.get(id)?.store.clearAll();
      return files.delete(id);
    },
    __relaunch: () => {
      opened = new Set();
    },
    __uninstall: () => {
      // Emptied too: an instance a module kept across the uninstall reads what a new process would.
      for (const file of files.values()) file.store.clearAll();
      files.clear();
      opened = new Set();
    },
  };
});
