import type { SocialLink } from '@/lib/types'
import { APPROVED_PAYMENT_SCHEMES, parsePaymentUri } from '@/lib/utils/payment-uri'
import { socialLinkAddProblem, validateSocialHandle } from '@/lib/social-link-validation'

/**
 * The edit-profile form keeps links and tip addresses as editable rows, so a
 * half-typed row can sit in the form. These turn the rows into what a profile
 * stores and say what is wrong with each row; blank rows are dropped.
 */

export interface TipRow {
  /** An approved scheme, colon included (`dash:`). */
  scheme: string
  address: string
}

/** A row with a stable key, so removing one keeps the others' focus and input. */
export type Keyed<T> = T & { key: number }

let nextRowKey = 1
export function rowKey(): number {
  return nextRowKey++
}

interface RowCheck<T> {
  values: T[]
  /** One entry per row, in order: the problem, or null. */
  errors: (string | null)[]
}

/** A stored payment URI as a row; anything without a scheme keeps `fallbackScheme`. */
export function tipRowFromUri(uri: string, fallbackScheme: string): TipRow {
  return splitPaymentUri(uri) ?? { scheme: fallbackScheme, address: uri }
}

/** A pasted `scheme:address` split on an approved scheme, else null. */
export function splitPaymentUri(value: string): TipRow | null {
  const trimmed = value.trim()
  const colon = trimmed.indexOf(':')
  if (colon <= 0) return null
  const scheme = trimmed.slice(0, colon + 1).toLowerCase()
  if (!APPROVED_PAYMENT_SCHEMES.some((approved) => approved === scheme)) return null
  return { scheme, address: trimmed.slice(colon + 1) }
}

/**
 * `saved` are the links the profile already stores: one left as it was skips
 * the handle rules (they may have changed since it was saved), so opening the
 * form never flags what the profile already shows. Size and repeats still count.
 */
export function checkLinkRows(
  rows: readonly SocialLink[],
  platformLabel: (platform: string) => string,
  saved: readonly SocialLink[] = [],
): RowCheck<SocialLink> {
  const values: SocialLink[] = []
  const errors = rows.map((row) => {
    const handle = row.handle.trim()
    if (!handle) return null
    const link = { platform: row.platform, handle }
    const unchanged = saved.some((s) => s.platform === row.platform && s.handle.trim() === handle)
    const problem = (unchanged ? null : validateSocialHandle(row.platform, handle)) ?? socialLinkAddProblem(values, link, platformLabel(row.platform))
    if (!problem) values.push(link)
    return problem
  })
  return { values, errors }
}

/** As checkLinkRows: a `saved` payment URI left as it was is kept without re-checking its address. */
export function checkTipRows(
  rows: readonly TipRow[],
  schemeLabel: (scheme: string) => string,
  saved: readonly string[] = [],
): RowCheck<string> {
  const values: string[] = []
  const errors = rows.map((row) => {
    const address = row.address.trim()
    if (!address) return null
    const savedUri = saved.find((uri) => tipRowsMatch(tipRowFromUri(uri, row.scheme), row.scheme, address))
    const uri = savedUri ?? parsePaymentUri(row.scheme + address)?.uri
    if (!uri) return `That doesn't look like a ${schemeLabel(row.scheme)} address`
    if (values.some((other) => other.toLowerCase() === uri.toLowerCase())) return 'Already added'
    values.push(uri)
    return null
  })
  return { values, errors }
}

function tipRowsMatch(row: TipRow, scheme: string, address: string): boolean {
  return row.scheme === scheme && row.address.trim() === address
}

/** A website typed without a scheme gets `https://` when it still fits, so the profile can link it. */
export function normalizeWebsite(value: string, maxLength = Infinity): string {
  const trimmed = value.trim()
  if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  const withScheme = `https://${trimmed}`
  return withScheme.length <= maxLength ? withScheme : trimmed
}
