import { requireOptionalNativeModule } from 'expo';

interface BackgroundFlushModule {
  begin(): number;
  end(id: number): void;
  wipeKeychainServices(services: string[]): void;
}

/** iOS only; on Android these are no-ops (see each function). */
const native = requireOptionalNativeModule<BackgroundFlushModule>('BackgroundFlush');

/**
 * Run `work` inside an iOS background task (`beginBackgroundTask`), so a
 * flush started as the app goes to the background is not frozen half way.
 * Android keeps the process alive long enough without help.
 */
export async function withBackgroundTask<T>(work: () => Promise<T>): Promise<T> {
  const id = native?.begin();
  try {
    return await work();
  } finally {
    if (id !== undefined) native?.end(id);
  }
}

/**
 * iOS: delete every Keychain item expo-secure-store stored under these
 * services (it suffixes `:auth` / `:no-auth`; all variants go). Keychain
 * items survive an uninstall, unlike app data; Android drops Keystore-backed
 * data with the app, so there is nothing to do there.
 */
export function wipeKeychainServices(services: string[]): void {
  native?.wipeKeychainServices(services);
}
