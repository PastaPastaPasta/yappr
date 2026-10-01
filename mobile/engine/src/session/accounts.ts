import { SESSION_STORAGE_KEY, scopedKey } from '@/lib/storage-scope'

/**
 * The engine's account registry (ENGINE.md §6.3 `session.accounts`). lib has
 * one session slot (`yappr_session`), so the engine keeps every signed-in
 * account here, in engine kv, with the saved session of each inactive one.
 * Secrets are not here: they live in the secure area, and only the active
 * account's are hydrated into the engine.
 */

export const ACCOUNTS_STORAGE_KEY = 'yappr_engine_accounts'
/** Set by a switch, read once by the next boot's restore so it reports `switched`. */
export const SWITCH_MARKER_KEY = 'yappr_engine_switch_pending'

export type SignInMethod = 'key' | 'key-exchange' | 'app-connect'

export interface AccountRecord {
  identityId: string
  username: string | null
  method: SignInMethod
  lastUsedAt: number
  /** The account's `yappr_session` while it is not the active one. */
  savedSession?: string
}

/**
 * lib keeps these per-identity stores under one global key, so a switch
 * stashes the old account's copy and restores the new one's.
 */
const STASHED_KEYS = { notifications: scopedKey('yappr-notifications') } as const

const stashKey = (identityId: string, name: string) => `yappr_engine_stash:${identityId}:${name}`

export function createAccountRegistry(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, now: () => number = Date.now) {
  function read(): AccountRecord[] {
    try {
      const parsed = JSON.parse(storage.getItem(ACCOUNTS_STORAGE_KEY) ?? '[]') as unknown
      return Array.isArray(parsed) ? parsed as AccountRecord[] : []
    } catch {
      return []
    }
  }

  function write(accounts: AccountRecord[]): void {
    storage.setItem(ACCOUNTS_STORAGE_KEY, JSON.stringify(accounts))
  }

  /** The identity of lib's session slot. */
  function activeIdentityId(): string | null {
    try {
      const session = JSON.parse(storage.getItem(SESSION_STORAGE_KEY) ?? 'null') as { user?: { identityId?: unknown } } | null
      return typeof session?.user?.identityId === 'string' ? session.user.identityId : null
    } catch {
      return null
    }
  }

  /** Move the active account out of lib's slot: save its session and stash its per-identity stores. */
  function parkActive(): void {
    const activeId = activeIdentityId()
    if (!activeId) return
    const accounts = read()
    const entry = accounts.find(account => account.identityId === activeId)
    const session = storage.getItem(SESSION_STORAGE_KEY)
    if (entry && session) entry.savedSession = session
    write(accounts)
    for (const [name, key] of Object.entries(STASHED_KEYS)) {
      const value = storage.getItem(key)
      if (value === null) storage.removeItem(stashKey(activeId, name))
      else storage.setItem(stashKey(activeId, name), value)
      storage.removeItem(key)
    }
    storage.removeItem(SESSION_STORAGE_KEY)
  }

  return {
    list(): AccountRecord[] {
      return read()
    },

    get(identityId: string): AccountRecord | undefined {
      return read().find(account => account.identityId === identityId)
    },

    activeIdentityId,

    /** Record a sign-in (the account is now in lib's slot). */
    upsert(identityId: string, patch: { username: string | null; method?: SignInMethod }): void {
      const accounts = read()
      const entry = accounts.find(account => account.identityId === identityId)
      if (entry) {
        entry.username = patch.username
        if (patch.method) entry.method = patch.method
        entry.lastUsedAt = now()
        delete entry.savedSession
      } else {
        accounts.push({ identityId, username: patch.username, method: patch.method ?? 'key', lastUsedAt: now() })
      }
      write(accounts)
    },

    /**
     * Prepare lib's storage for the engine restart that completes a switch:
     * park the active account, then put the target's saved session and
     * stashed stores in place. `target` null leaves the slot empty (adding an
     * account). The caller restarts the engine with the target's secrets.
     */
    switchTo(target: string | null): void {
      parkActive()
      if (target) {
        const accounts = read()
        const entry = accounts.find(account => account.identityId === target)
        if (entry?.savedSession) storage.setItem(SESSION_STORAGE_KEY, entry.savedSession)
        if (entry) {
          entry.lastUsedAt = now()
          delete entry.savedSession
          write(accounts)
        }
        for (const [name, key] of Object.entries(STASHED_KEYS)) {
          const value = storage.getItem(stashKey(target, name))
          if (value !== null) storage.setItem(key, value)
        }
      }
      storage.setItem(SWITCH_MARKER_KEY, '1')
    },

    /** Whether this boot follows a switch (read once). */
    takeSwitchMarker(): boolean {
      const marked = storage.getItem(SWITCH_MARKER_KEY) !== null
      if (marked) storage.removeItem(SWITCH_MARKER_KEY)
      return marked
    },

    /**
     * Forget an account: its registry entry and stashes, and for the active
     * account the live copies of its per-identity stores too.
     */
    remove(identityId: string): void {
      const active = activeIdentityId() === identityId
      write(read().filter(account => account.identityId !== identityId))
      for (const [name, key] of Object.entries(STASHED_KEYS)) {
        storage.removeItem(stashKey(identityId, name))
        if (active) storage.removeItem(key)
      }
    },
  }
}

export type AccountRegistry = ReturnType<typeof createAccountRegistry>
