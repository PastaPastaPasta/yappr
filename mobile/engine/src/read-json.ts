/**
 * Parse a JSON value the engine keeps in storage, or `fallback` when it is
 * missing or corrupt: a bad entry loses its data, never the engine. Unlike
 * lib's `parseJsonArray`, it never logs the raw value (one of these holds an
 * ephemeral private key).
 */
export function readJson<T>(storage: Pick<Storage, 'getItem'>, key: string, fallback: T): T {
  try {
    const raw = storage.getItem(key)
    return raw === null ? fallback : JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
