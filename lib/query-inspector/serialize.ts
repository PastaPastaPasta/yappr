/**
 * Serialization helpers for the query inspector.
 *
 * SDK values mix plain JSON, Maps, bigints, Uint8Arrays, and wasm-bindgen
 * objects. `toPlain` converts all of them into bounded, JSON-safe data so a
 * record can outlive the wasm objects it was captured from.
 */

const MAX_DEPTH = 6
const MAX_ARRAY_ITEMS = 200
const MAX_MAP_ENTRIES = 200
const MAX_STRING_LENGTH = 4096

export function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(Math.floor(hex.length / 2))
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function truncateString(value: string): string {
  return value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}… (${value.length} chars)`
    : value
}

interface JsonConvertible {
  toJSON?: () => unknown
  toObject?: () => unknown
}

export function toPlain(value: unknown, depth = 0): unknown {
  try {
    if (value === null || value === undefined) return null
    if (typeof value === 'string') return truncateString(value)
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'function') return undefined
    if (depth > MAX_DEPTH) return '…'

    if (value instanceof Uint8Array) {
      return truncateString(bytesToHex(value))
    }

    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => toPlain(item, depth + 1))
      if (value.length > MAX_ARRAY_ITEMS) {
        items.push(`… ${value.length - MAX_ARRAY_ITEMS} more items`)
      }
      return items
    }

    if (value instanceof Map) {
      const out: Record<string, unknown> = {}
      let count = 0
      value.forEach((entry, key) => {
        if (count >= MAX_MAP_ENTRIES) return
        out[String(key)] = toPlain(entry, depth + 1)
        count++
      })
      if (value.size > MAX_MAP_ENTRIES) {
        out['…'] = `${value.size - MAX_MAP_ENTRIES} more entries`
      }
      return out
    }

    if (typeof value === 'object') {
      // wasm-bindgen classes expose toJSON/toObject; either can throw if the
      // underlying pointer was already freed.
      const convertible = value as JsonConvertible
      if (typeof convertible.toJSON === 'function') {
        try {
          const json = convertible.toJSON()
          if (json !== value) return toPlain(json, depth + 1)
        } catch {
          // fall through
        }
      }
      if (typeof convertible.toObject === 'function') {
        try {
          const obj = convertible.toObject()
          if (obj !== value) return toPlain(obj, depth + 1)
        } catch {
          return '[wasm object no longer available]'
        }
      }

      const out: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        const plain = toPlain(entry, depth + 1)
        if (plain !== undefined) out[key] = plain
      }
      return out
    }

    return String(value)
  } catch {
    return '[unserializable]'
  }
}

// Total per-entry ceiling on a serialized result. toPlain bounds each node's
// width but not the aggregate; a 200-document feed page could still reach
// hundreds of KB, and the ring buffer holds up to 300 entries.
const MAX_RESULT_JSON_CHARS = 262_144

/** toPlain with a total-size guard, for query results. */
export function toBoundedPlain(value: unknown): unknown {
  const plain = toPlain(value)
  try {
    const text = JSON.stringify(plain)
    if (text && text.length > MAX_RESULT_JSON_CHARS) {
      return `[result too large to display: ~${Math.round(text.length / 1024)} KB serialized]`
    }
  } catch {
    // keep the plain value if it can't be measured
  }
  return plain
}

/** One-line description of a live result value, computed before serialization. */
export function summarizeResult(value: unknown): string {
  if (value === null || value === undefined) return 'empty'
  if (value instanceof Map) return `${value.size} ${value.size === 1 ? 'entry' : 'entries'}`
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? 'item' : 'items'}`
  if (value instanceof Uint8Array) return `${value.length} bytes`
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') {
    return value.length > 60 ? `${value.slice(0, 60)}…` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    const name = value.constructor?.name
    return name && name !== 'Object' ? name : 'object'
  }
  return typeof value
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}
