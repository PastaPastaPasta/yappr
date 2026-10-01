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
 * does. Cycles throw. Keys are written as own data properties, so a
 * `__proto__` key round-trips as a key and never sets a prototype.
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

export interface EncodeOptions {
  /** Include `Error.stack`. Off by default: stacks are large and only useful in diagnostics. */
  includeStack?: boolean
}

const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key)

/** Set `key` as an own data property, even when it is `__proto__`. */
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
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
    if (ArrayBuffer.isView(object)) {
      return { $t: 'bytes', v: bytesToBase64(new Uint8Array(object.buffer, object.byteOffset, object.byteLength)) } satisfies Tagged
    }
    if (object instanceof ArrayBuffer) return { $t: 'bytes', v: bytesToBase64(new Uint8Array(object)) } satisfies Tagged

    if (seen.has(object)) throw new TypeError('encode: value contains a cycle')
    seen.add(object)
    try {
      if (object instanceof Error || isErrorLike(object)) return { $t: 'error', v: serializeError(object, walk, options) } satisfies Tagged
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
        if (encoded !== undefined) define(out, key, encoded)
      }
      return hasOwn(out, '$t') ? ({ $t: 'obj', v: out } satisfies Tagged) : out
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
  if (!hasOwn(record, '$t')) return decodeEntries(record)

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
      return new RemoteError(decodeSerializedError(tagged.v))
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

/** The error a remote call rejects with: a real Error, with the SDK's fields and cause restored. */
export class RemoteError extends Error {
  code?: string | number
  kind?: string | number
  isRetriable?: boolean
  data?: Record<string, unknown>
  /** An own `error` field (SDK errors wrap their inner error there), lifted out of `data` so `consensusCodeOf` finds it. */
  error?: unknown
  remoteStack?: string

  constructor(serialized: SerializedError) {
    super(serialized.message)
    this.name = serialized.name
    // Defined rather than passed to super(): Hermes's Error constructor may ignore the options bag.
    if (serialized.cause) {
      Object.defineProperty(this, 'cause', { value: new RemoteError(serialized.cause), writable: true, configurable: true })
    }
    if (serialized.code !== undefined) this.code = serialized.code
    if (serialized.kind !== undefined) this.kind = serialized.kind
    if (serialized.isRetriable !== undefined) this.isRetriable = serialized.isRetriable
    if (serialized.data !== undefined) {
      const { error, ...rest } = serialized.data
      if (error !== undefined) this.error = error
      if (Object.keys(rest).length > 0) this.data = rest
    }
    if (serialized.stack !== undefined) this.remoteStack = serialized.stack
  }
}

/** Fields read by name (they may be prototype getters) rather than copied from own properties. */
const ERROR_FIELDS = new Set(['name', 'message', 'code', 'kind', 'isRetriable', 'stack', 'cause'])
const MAX_CAUSE_DEPTH = 3

/** Read a property that may be a getter which throws (a freed wasm error). */
function read(object: object, key: string): unknown {
  try {
    return (object as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/**
 * Flatten a thrown value into a SerializedError. Works on real Errors and on
 * evo-sdk's `WasmSdkError`, which does not extend Error and exposes `name`,
 * `message`, `code`, `kind` and `isRetriable` as prototype getters. `cause` is
 * followed a few levels. `walk` maps each extra own field; the default keeps
 * it raw, for callers that encode the result afterwards.
 */
export function serializeError(
  error: unknown,
  walk: (value: unknown) => unknown = value => value,
  options: EncodeOptions = {},
  depth = 0
): SerializedError {
  if (typeof error !== 'object' || error === null) return { name: 'Error', message: String(error) }

  const name = read(error, 'name')
  const message = read(error, 'message')
  const out: SerializedError = {
    name: typeof name === 'string' && name ? name : 'Error',
    message: typeof message === 'string' ? message : String(error),
  }
  const code = read(error, 'code')
  if (typeof code === 'string' || typeof code === 'number') out.code = code
  const kind = read(error, 'kind')
  if (typeof kind === 'string' || typeof kind === 'number') out.kind = kind
  const isRetriable = read(error, 'isRetriable')
  if (typeof isRetriable === 'boolean') out.isRetriable = isRetriable
  const stack = read(error, 'stack')
  if (options.includeStack && typeof stack === 'string') out.stack = stack
  const cause = read(error, 'cause')
  if (cause !== undefined && depth < MAX_CAUSE_DEPTH) out.cause = serializeError(cause, walk, options, depth + 1)

  const data: Record<string, unknown> = {}
  for (const key of Object.keys(error)) {
    if (ERROR_FIELDS.has(key) || key === '__wbg_ptr') continue
    try {
      const encoded = walk(read(error, key))
      if (encoded !== undefined) define(data, key, encoded)
    } catch {
      // A field that cannot cross the bridge is dropped, never the error itself.
    }
  }
  if (Object.keys(data).length > 0) out.data = data
  return out
}

/** Decode the `data` of an encoded SerializedError (and of its causes). */
function decodeSerializedError(serialized: SerializedError): SerializedError {
  return {
    ...serialized,
    data: serialized.data && decodeEntries(serialized.data),
    cause: serialized.cause && decodeSerializedError(serialized.cause),
  }
}

function decodeEntries(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) define(out, key, decode(item))
  return out
}

/**
 * A class instance that reads as an error without extending Error: evo-sdk's
 * WasmSdkError (prototype getters for `name` and `message`). Plain objects are
 * never treated as errors, so DTOs that happen to have those keys stay data.
 */
function isErrorLike(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  if (proto === Object.prototype || proto === null) return false
  return typeof read(value, 'name') === 'string' && typeof read(value, 'message') === 'string'
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
