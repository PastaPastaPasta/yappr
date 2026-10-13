import { vi } from 'vitest'

/** A Map-backed Web Storage for unit tests that run modules reading `localStorage`/`sessionStorage`. */
export function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key)
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value))
    },
  }
}

/** Stub `window`, `localStorage` and `sessionStorage` with fresh in-memory stores. */
export function stubBrowserStorage(): void {
  vi.stubGlobal('window', {})
  vi.stubGlobal('localStorage', memoryStorage())
  vi.stubGlobal('sessionStorage', memoryStorage())
}

/** Env for an App Connect build pinned to `appId` (group, owner and members filled in validly). */
export function stubAppConnectBuild(appId: string, filler: string): void {
  vi.stubEnv('NEXT_PUBLIC_LOGIN_PROTOCOL', 'app-connect')
  vi.stubEnv('NEXT_PUBLIC_APP_CONNECT_APP_ID', appId)
  vi.stubEnv('NEXT_PUBLIC_APP_CONNECT_GROUP_ID', filler)
  vi.stubEnv('NEXT_PUBLIC_APP_CONNECT_GROUP_OWNER', filler)
  vi.stubEnv('NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS', appId)
}
