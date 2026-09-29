import { YAPPR_CONTRACT_ID, YAPPR_PROFILE_CONTRACT_ID } from '@/lib/constants'
import { dashpayProfileExtension } from '@/lib/contract-topology'
import { normalizeBytes } from '@/lib/bytes'
import { ListLimitError } from '@/lib/typed-array-codecs'

/**
 * Where a profile lives, and how the v10 split maps onto the one profile
 * shape the app reads (docs/SOCIAL_V10.md, "The DashPay profile and the
 * extension").
 *
 * On v2 and v9 a profile is one `profile` document in the profile contract.
 * On v10 it is two: the DashPay `profile` (the name, the bio as
 * `publicMessage`, and an image avatar with its hash and fingerprint), shared
 * with every DashPay wallet, and the social contract's `yapprProfile`
 * extension (everything else Yappr adds). The extension requires a DashPay
 * profile owned by its writer (40120), so the DashPay profile is written first.
 */

export interface ProfileSource {
  readonly contractId: string
  readonly documentType: string
}

/** The document every profile has: DashPay's `profile` on v10, else the profile contract's. */
export function profileBaseSource(): ProfileSource {
  const v10 = dashpayProfileExtension()
  return v10
    ? { contractId: v10.base.contractId, documentType: v10.base.documentType }
    : { contractId: YAPPR_PROFILE_CONTRACT_ID, documentType: 'profile' }
}

/** The v10 `yapprProfile` extension in the social contract; null on v2 and v9. */
export function profileExtensionSource(): ProfileSource | null {
  const v10 = dashpayProfileExtension()
  return v10 ? { contractId: YAPPR_CONTRACT_ID, documentType: v10.extensionDocType } : null
}

/**
 * The two documents of a v10 profile: `base` is the DashPay `profile` (and
 * the whole profile on v2 and v9), `extension` the social `yapprProfile`.
 */
export type ProfileRole = 'base' | 'extension'

/**
 * The profile document types of the configured cut, base first. Callers that
 * fetch profiles alongside other documents (a composite page, an identity
 * bundle) query each and seed it back into the profile service by role.
 */
export function profileSources(): Array<{ readonly role: ProfileRole; readonly source: ProfileSource }> {
  const extension = profileExtensionSource()
  return [
    { role: 'base', source: profileBaseSource() },
    ...(extension ? [{ role: 'extension' as const, source: extension }] : []),
  ]
}

/** DashPay profile v2's caps on the name and the bio (`publicMessage`). */
export const DASHPAY_PROFILE_LIMITS = { displayName: 25, bio: 140 } as const
/** The profile contract's caps (v2, v9). */
const PROFILE_CONTRACT_LIMITS = { displayName: 50, bio: 160 } as const
/** `yapprProfile.avatar`: a DiceBear recipe, used when DashPay has no `avatarUrl`. */
const EXTENSION_AVATAR_MAX_LENGTH = 128

/** The display name and bio caps of the configured cut, in characters. */
export function profileTextLimits(): { readonly displayName: number; readonly bio: number } {
  return dashpayProfileExtension() ? DASHPAY_PROFILE_LIMITS : PROFILE_CONTRACT_LIMITS
}

/** A recipe with an empty seed and the longest DiceBear style name. */
const LONGEST_EMPTY_RECIPE = JSON.stringify({ seed: '', style: 'adventurer-neutral' })

/** The longest custom DiceBear seed whose recipe the configured cut stores. */
export function avatarSeedMaxLength(): number {
  return dashpayProfileExtension() ? EXTENSION_AVATAR_MAX_LENGTH - LONGEST_EMPTY_RECIPE.length : 100
}

/** An avatar value that is an image URI rather than a DiceBear recipe. */
export function isImageAvatar(avatar: string): boolean {
  return avatar.startsWith('http://') || avatar.startsWith('https://') || avatar.startsWith('ipfs://')
}

/** The fields `yapprProfile` carries, in the profile contract's names. */
const EXTENSION_FIELDS = ['location', 'website', 'bannerUri', 'pronouns', 'nsfw', 'paymentUris', 'socialLinks', 'avatar'] as const
/** DashPay fields Yappr never edits but must carry through a replace (byte arrays). */
const DASHPAY_PRESERVED_BYTE_FIELDS = ['corePaymentAddress', 'platformPaymentAddress'] as const
const SYSTEM_FIELDS = ['$id', '$ownerId', '$createdAt', '$updatedAt', '$revision'] as const

type PlainDocument = Record<string, unknown>

/** A query record's content fields (the SDK may nest them under `data`). */
function contentOf(doc: PlainDocument): PlainDocument {
  const nested = doc.data && typeof doc.data === 'object' && !Array.isArray(doc.data)
  return (nested ? doc.data : doc) as PlainDocument
}

function systemField(doc: PlainDocument, field: typeof SYSTEM_FIELDS[number]): unknown {
  return doc[field] ?? doc[field.slice(1)]
}

/**
 * One profile record in the profile contract's shape, from a v10 DashPay
 * profile and extension (either may be missing; null when both are). The
 * name and bio come from DashPay; the avatar is DashPay's image when it has
 * one, else the extension's recipe; everything else is the extension's.
 * System fields are the extension's (when the user joined Yappr), falling
 * back to DashPay's.
 */
export function mergeV10ProfileRecords(base: PlainDocument | null, extension: PlainDocument | null): PlainDocument | null {
  const primary = extension ?? base
  if (!primary) return null
  const baseContent = base ? contentOf(base) : {}
  const extensionContent = extension ? contentOf(extension) : {}

  const merged: PlainDocument = {}
  for (const field of SYSTEM_FIELDS) {
    const value = systemField(primary, field) ?? (base ? systemField(base, field) : undefined)
    if (value !== undefined) merged[field] = value
  }
  for (const field of EXTENSION_FIELDS) {
    if (extensionContent[field] !== undefined) merged[field] = extensionContent[field]
  }
  merged.displayName = typeof baseContent.displayName === 'string' ? baseContent.displayName : ''
  if (typeof baseContent.publicMessage === 'string') merged.bio = baseContent.publicMessage
  if (typeof baseContent.avatarUrl === 'string' && baseContent.avatarUrl) merged.avatar = baseContent.avatarUrl
  return merged
}

/** The sha256 of the bytes at an image URL and the dHash of the decoded image. */
export interface ImageDigest {
  readonly hash: Uint8Array
  readonly fingerprint: Uint8Array
}

/**
 * A profile edit in the profile contract's field names. `undefined` keeps the
 * stored value; an empty string (or list) removes an optional field. Lists
 * arrive already encoded for the extension.
 */
export interface V10ProfilePatch {
  displayName?: string
  bio?: string
  avatar?: string
  location?: string
  website?: string
  bannerUri?: string
  pronouns?: string
  nsfw?: boolean
  paymentUris?: string[]
  socialLinks?: string[]
}

export interface V10ProfileWrite {
  /** Stored content of each document, or null when it does not exist yet. */
  readonly base: PlainDocument | null
  readonly extension: PlainDocument | null
  readonly patch: V10ProfilePatch
  /**
   * The digest of an image avatar DashPay does not already store. Absent when
   * the image could not be fetched or decoded (a host without CORS, an SVG):
   * the URI then goes in the extension, and DashPay keeps no image.
   */
  readonly avatarDigest?: ImageDigest
  /** The recipe written when the extension would otherwise be empty (`minProperties: 1`). */
  readonly fallbackAvatar: string
}

/** The documents to write, DashPay first; null leaves that document as it is. */
export interface V10ProfileWritePlan {
  readonly base: PlainDocument | null
  readonly extension: PlainDocument | null
}

/** The image avatar URI the patch sets and DashPay does not already store, if any. */
export function avatarNeedingDigest(base: PlainDocument | null, patch: V10ProfilePatch): string | null {
  if (patch.avatar === undefined || !isImageAvatar(patch.avatar)) return null
  const stored = base ? contentOf(base).avatarUrl : undefined
  return stored === patch.avatar ? null : patch.avatar
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    const left = normalizeBytes(a)
    const right = normalizeBytes(b)
    return !!left && !!right && left.length === right.length && left.every((byte, i) => byte === right[i])
  }
  return JSON.stringify(a) === JSON.stringify(b)
}

function sameContent(a: PlainDocument, b: PlainDocument): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return Array.from(keys).every((key) => sameValue(a[key], b[key]))
}

/** Set `field` to the trimmed `value`, or remove it when that is empty. */
function applyText(target: PlainDocument, field: string, value: string | undefined): void {
  if (value === undefined) return
  const trimmed = value.trim()
  if (trimmed) target[field] = trimmed
  else delete target[field]
}

function assertMaxLength(value: unknown, max: number, message: string): void {
  if (typeof value === 'string' && Array.from(value).length > max) throw new ListLimitError(message)
}

/** DashPay's content as Yappr writes it back: its own fields plus the preserved byte fields. */
function baseContentFrom(base: PlainDocument | null): PlainDocument {
  if (!base) return {}
  const content = contentOf(base)
  const out: PlainDocument = {}
  for (const field of ['displayName', 'publicMessage', 'avatarUrl'] as const) {
    if (typeof content[field] === 'string') out[field] = content[field]
  }
  for (const field of ['avatarHash', 'avatarFingerprint', ...DASHPAY_PRESERVED_BYTE_FIELDS] as const) {
    const bytes = normalizeBytes(content[field])
    if (bytes) out[field] = bytes
  }
  return out
}

function extensionContentFrom(extension: PlainDocument | null): PlainDocument {
  if (!extension) return {}
  const content = contentOf(extension)
  const out: PlainDocument = {}
  for (const field of EXTENSION_FIELDS) {
    if (content[field] !== undefined) out[field] = content[field]
  }
  return out
}

/**
 * The DashPay profile and extension a profile edit produces. A document is
 * written only when it is missing or its content changes, so a user who
 * already has a DashPay profile and keeps its name, bio and avatar adds only
 * the extension. Refuses, with a message for the user, what either contract
 * would refuse after signing.
 */
export function planV10ProfileWrite({ base, extension, patch, avatarDigest, fallbackAvatar }: V10ProfileWrite): V10ProfileWritePlan {
  const storedBase = baseContentFrom(base)
  const storedExtension = extensionContentFrom(extension)
  const nextBase: PlainDocument = { ...storedBase }
  const nextExtension: PlainDocument = { ...storedExtension }

  // A blank name keeps the stored one, as the profile contract's edit does.
  if (patch.displayName?.trim()) nextBase.displayName = patch.displayName.trim()
  applyText(nextBase, 'publicMessage', patch.bio)
  for (const field of ['location', 'website', 'bannerUri', 'pronouns'] as const) {
    applyText(nextExtension, field, patch[field])
  }
  if (patch.nsfw !== undefined) nextExtension.nsfw = patch.nsfw
  for (const field of ['paymentUris', 'socialLinks'] as const) {
    const list = patch[field]
    if (list === undefined) continue
    if (list.length > 0) nextExtension[field] = list
    else delete nextExtension[field]
  }

  if (patch.avatar !== undefined) {
    const avatar = patch.avatar.trim()
    if (avatar && isImageAvatar(avatar) && avatarDigest && avatarNeedingDigest(base, { avatar })) {
      nextBase.avatarUrl = avatar
      nextBase.avatarHash = avatarDigest.hash
      nextBase.avatarFingerprint = avatarDigest.fingerprint
    } else if (!avatar || !isImageAvatar(avatar) || avatarNeedingDigest(base, { avatar })) {
      // A recipe, no avatar, or an image that could not be fingerprinted:
      // DashPay's image (all three fields travel together) goes, and the
      // extension holds the value.
      delete nextBase.avatarUrl
      delete nextBase.avatarHash
      delete nextBase.avatarFingerprint
      if (avatar) nextExtension.avatar = avatar
      else delete nextExtension.avatar
    }
  }
  if (Object.keys(nextExtension).length === 0) nextExtension.avatar = fallbackAvatar

  const writeBase = !base || !sameContent(storedBase, nextBase)
  if (writeBase) {
    // A DashPay profile created here always carries a name, though DashPay
    // itself only asks for one property (a wallet's may have none).
    if (!base && !nextBase.displayName) throw new ListLimitError('Display name is required')
    if (Object.keys(nextBase).length === 0) throw new ListLimitError('Your Dash profile needs a name, a bio or an avatar')
    assertMaxLength(nextBase.displayName, DASHPAY_PROFILE_LIMITS.displayName,
      `Display name must be at most ${DASHPAY_PROFILE_LIMITS.displayName} characters`)
    assertMaxLength(nextBase.publicMessage, DASHPAY_PROFILE_LIMITS.bio,
      `Bio must be at most ${DASHPAY_PROFILE_LIMITS.bio} characters`)
  }
  assertMaxLength(nextExtension.avatar, EXTENSION_AVATAR_MAX_LENGTH, typeof nextExtension.avatar === 'string' && isImageAvatar(nextExtension.avatar)
    ? `The avatar image could not be read to fingerprint it, and its address is over ${EXTENSION_AVATAR_MAX_LENGTH} characters; try uploading it instead`
    : `The avatar settings must be at most ${EXTENSION_AVATAR_MAX_LENGTH} characters; try a shorter seed`)

  return {
    base: writeBase ? nextBase : null,
    extension: extension && sameContent(storedExtension, nextExtension) ? null : nextExtension,
  }
}
