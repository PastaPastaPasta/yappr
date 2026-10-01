import type { SerializedError } from './envelope'

/**
 * A JSON codec for the values engine calls exchange.
 *
 * `encode` maps a value onto plain JSON, tagging what JSON cannot carry as
 * `{ $t: <tag>, v: <data> }`; `decode` reverses it. Supported beyond JSON:
 * Date, Uint8Array (any ArrayBufferView or ArrayBuffer arrives as Uint8Array),
 * bigint, Map, Set, undefined (in arrays and as object values), NaN/±Infinity,
 * and Error. A plain object that itself has a `$t` key is wrapped, so user
 * data can never be mistaken for a tag.
 *
 * Class instances are sent as their own enumerable properties (after
 * `toJSON()` if they define one); functions and symbols are dropped, as JSON
 * does. Cycles throw.
 */

type Tagged =
  | { $t: 'undef' }
  | { $t: 'num'; v: 'NaN' | 'Infinity' | '-Infinity' }
  | { $t: 'date'; v: string | null }
  | { $t: 'bytes'; v: string }
  | { $t: 'bigint'; v: string }
  | { $t: 'map'; v: [unknown, unknown][] }
  | { $t: 'set'; v: unknown[] }
  | { $t: 'error'; v: SerializedError }
  | { $t: 'obj'; v: Record<string, unknown> }

const TAG = '$t'

export interface EncodeOptions {
  /** Include `Error.stack`. Off by default: stacks are large and only useful in diagnostics. */
  includeStack?: boolean
}

export function encode(value: unknown, options: EncodeOptions = {}): unknown {
  const seen = new Set<object>()

  const walk = (input: unknown): unknown => {
    switch (typeof input) {
      case 'undefined':
        return { $t: 'undef' } satisfies Tagged
      case 'number':
        if (Number.isFinite(input)) return input
        return { $t: 'num', v: Number.isNaN(input) ? 'NaN' : input > 0 ? 'Infinity' : '-Infinity' } satisfies Tagged
      case 'bigint':
        return { $t: 'bigint', v: input.toString() } satisfies Tagged
      case 'string':
      case 'boolean':
        return input
      case 'function':
      case 'symbol':
        return undefined
    }
    if (input === null) return null
    const object = input as object

    if (object instanceof Date) {
      const time = object.getTime()
      return { $t: 'date', v: Number.isNaN(time) ? null : object.toISOString() } satisfies Tagged
    }
    if (object instanceof Uint8Array) return { $t: 'bytes', v: bytesToBase64(object) } satisfies Tagged
    if (ArrayBuffer.isView(object)) {
      return { $t: 'bytes', v: bytesToBase64(new Uint8Array(object.buffer, object.byteOffset, object.byteLength)) } satisfies Tagged
    }
    if (object instanceof ArrayBuffer) return { $t: 'bytes', v: bytesToBase64(new Uint8Array(object)) } satisfies Tagged

    if (seen.has(object)) throw new TypeError('encode: value contains a cycle')
    seen.add(object)
    try {
      if (object instanceof Error) return { $t: 'error', v: serializeError(object, walk, options) } satisfies Tagged
      if (object instanceof Map) {
        return { $t: 'map', v: Array.from(object, ([k, v]) => [walk(k), walk(v)] as [unknown, unknown]) } satisfies Tagged
      }
      if (object instanceof Set) return { $t: 'set', v: Array.from(object, walk) } satisfies Tagged
      if (Array.isArray(object)) return object.map(item => walk(item) ?? null)

      const source = hasToJSON(object) ? object.toJSON() : object
      if (source !== object) return walk(source)
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(object)) {
        const encoded = walk(item)
        if (encoded !== undefined) out[key] = encoded
      }
      return TAG in out ? ({ $t: 'obj', v: out } satisfies Tagged) : out
    } finally {
      seen.delete(object)
    }
  }

  return walk(value)
}

export function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode)
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  if (!(TAG in record)) return decodeEntries(record)

  const tagged = record as Tagged
  switch (tagged.$t) {
    case 'undef':
      return undefined
    case 'num':
      return Number(tagged.v)
    case 'date':
      return new Date(tagged.v ?? Number.NaN)
    case 'bytes':
      return base64ToBytes(tagged.v)
    case 'bigint':
      return BigInt(tagged.v)
    case 'map':
      return new Map(tagged.v.map(([k, v]) => [decode(k), decode(v)]))
    case 'set':
      return new Set(tagged.v.map(decode))
    case 'error':
      return deserializeError(tagged.v)
    case 'obj':
      return decodeEntries(tagged.v)
    default:
      throw new TypeError(`decode: unknown tag ${JSON.stringify((record as { $t: unknown }).$t)}`)
  }
}

export function stringify(value: unknown, options?: EncodeOptions): string {
  return JSON.stringify(encode(value, options))
}

export function parse(text: string): unknown {
  return decode(JSON.parse(text))
}

/** The error a remote call rejects with: a real Error, with `code` and `data` restored. */
export class RemoteError extends Error {
  code?: string | number
  data?: Record<string, unknown>
  remoteStack?: string

  constructor(serialized: SerializedError) {
    super(serialized.message)
    this.name = serialized.name
    if (serialized.code !== undefined) this.code = serialized.code
    if (serialized.data !== undefined) this.data = serialized.data
    if (serialized.stack !== undefined) this.remoteStack = serialized.stack
  }
}

/**
 * Flatten an error into a SerializedError. `walk` maps each extra own field;
 * the default keeps it raw, for callers that encode the result afterwards.
 */
export function serializeError(
  error: unknown,
  walk: (value: unknown) => unknown = value => value,
  options: EncodeOptions = {}
): SerializedError {
  if (!(error instanceof Error)) {
    // Thrown non-Errors (strings, wasm error objects with a message getter).
    const message = typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : String(error)
    return { name: 'Error', message }
  }
  const out: SerializedError = { name: error.name || 'Error', message: error.message }
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' || typeof code === 'number') out.code = code
  if (options.includeStack && error.stack) out.stack = error.stack
  const data: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(error)) {
    if (key === 'name' || key === 'message' || key === 'code' || key === 'stack') continue
    try {
      const encoded = walk(item)
      if (encoded !== undefined) data[key] = encoded
    } catch {
      // A field that cannot cross the bridge is dropped, never the error itself.
    }
  }
  if (Object.keys(data).length > 0) out.data = data
  return out
}

function deserializeError(serialized: SerializedError): RemoteError {
  const data = serialized.data ? (decodeEntries(serialized.data) as Record<string, unknown>) : undefined
  return new RemoteError({ ...serialized, ...(data ? { data } : {}) })
}

function decodeEntries(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) out[key] = decode(item)
  return out
}

function hasToJSON(value: object): value is { toJSON(): unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === 'function'
}

const CHUNK = 0x8000

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
