import type { CacheEntry } from '../types';

const IN_MEMORY_CACHE = new Map<string, CacheEntry<unknown>>();
const STORAGE_PREFIX = 'yappr_embed_cache:';

function getStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function now(): number {
  return Date.now();
}

export function readCache<T>(key: string): T | null {
  const storageKey = `${STORAGE_PREFIX}${key}`;
  const storage = getStorage();

  if (storage) {
    const raw = storage.getItem(storageKey);
    if (raw) {
      try {
        const entry = JSON.parse(raw) as CacheEntry<T>;
        if (entry.expiresAt > now()) {
          return entry.value;
        }
        storage.removeItem(storageKey);
      } catch {
        storage.removeItem(storageKey);
      }
    }
  }

  const memoryEntry = IN_MEMORY_CACHE.get(storageKey) as CacheEntry<T> | undefined;
  if (!memoryEntry) {
    return null;
  }

  if (memoryEntry.expiresAt <= now()) {
    IN_MEMORY_CACHE.delete(storageKey);
    return null;
  }

  return memoryEntry.value;
}

export function writeCache<T>(key: string, value: T, ttlMs: number): void {
  const entry: CacheEntry<T> = {
    value,
    expiresAt: now() + ttlMs
  };

  const storageKey = `${STORAGE_PREFIX}${key}`;
  const storage = getStorage();

  if (storage) {
    try {
      storage.setItem(storageKey, JSON.stringify(entry));
      return;
    } catch {
      // Fallback to in-memory cache when storage quota is exceeded.
    }
  }

  IN_MEMORY_CACHE.set(storageKey, entry as CacheEntry<unknown>);
}

export function clearStaleCache(): void {
  const time = now();
  const storage = getStorage();

  if (storage) {
    const keysToDelete: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key || !key.startsWith(STORAGE_PREFIX)) {
        continue;
      }
      const raw = storage.getItem(key);
      if (!raw) {
        keysToDelete.push(key);
        continue;
      }
      try {
        const entry = JSON.parse(raw) as CacheEntry<unknown>;
        if (entry.expiresAt <= time) {
          keysToDelete.push(key);
        }
      } catch {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach((key) => storage.removeItem(key));
  }

  for (const [key, entry] of IN_MEMORY_CACHE.entries()) {
    if (entry.expiresAt <= time) {
      IN_MEMORY_CACHE.delete(key);
    }
  }
}

export const CACHE_TTL = {
  post: 5 * 60 * 1000,
  blog: 30 * 60 * 1000,
  identity: 30 * 60 * 1000
};
