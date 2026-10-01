import { RpcError } from '../protocol/envelope'
import { bundleHash } from '../build-info'

/**
 * Opaque page cursors (ENGINE §6.1): base64url JSON `{v:1, k:<kind>, h, …}`.
 * RN only passes them back. A cursor is tied to the engine build that issued
 * it (`h`), because what its fields mean is an engine detail; one from another
 * build, another kind or garbage rejects with `BAD_CURSOR`, and RN reloads
 * from the top.
 */

const VERSION = 1

export type CursorFields = Record<string, string | number | boolean | null | string[]>

export function encodeCursor(kind: string, fields: CursorFields): string {
  const json = JSON.stringify({ ...fields, v: VERSION, k: kind, h: buildTag() })
  return toBase64Url(new TextEncoder().encode(json))
}

/** The fields of a cursor of `kind`, or `null` for no cursor (the first page). */
export function decodeCursor<T extends CursorFields>(cursor: string | null | undefined, kind: string): T | null {
  if (cursor === undefined || cursor === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(cursor)))
  } catch {
    throw badCursor(`not a cursor`)
  }
  if (!parsed || typeof parsed !== 'object') throw badCursor('not a cursor')
  const { v, k, h, ...fields } = parsed as { v?: unknown; k?: unknown; h?: unknown }
  if (v !== VERSION || h !== buildTag()) throw badCursor('issued by another engine build')
  if (k !== kind) throw badCursor(`a ${String(k)} cursor, expected ${kind}`)
  return fields as T
}

/** Integer cursor field, or BAD_CURSOR. */
export function cursorInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw badCursor('malformed')
  return value
}

/** String cursor field, or BAD_CURSOR. */
export function cursorString(value: unknown): string {
  if (typeof value !== 'string' || !value) throw badCursor('malformed')
  return value
}

export function badCursor(reason: string): RpcError {
  return new RpcError(`Bad cursor: ${reason}`, 'BAD_CURSOR')
}

const buildTag = () => bundleHash().slice(0, 12)

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url')
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}
