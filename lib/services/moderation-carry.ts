/**
 * How the blog and storefront services carry a document's moderator-only
 * fields (`mod`, `modLabel`, `$moderatedBy`, `$moderatedAt`; blog v10 and
 * storefront v11, docs/SOCIAL_V18.md) across a read and back into a write.
 *
 * - A read puts them on the object as `moderation` (absent when the document is
 *   listed, so a build before the hide-don't-delete cuts sees exactly what it
 *   did before).
 * - A replace must send `mod` and `modLabel` back unchanged: a write that drops
 *   or changes a moderator field is refused (41124).
 * - A list shown to the public drops hidden documents ({@link withoutHidden});
 *   an archival build keeps them.
 */

import { dropsHidden, moderationMarksOf, type ModerationMarks } from '@/lib/moderation-view'

/** The moderator marks a transformed document carries (`moderation`), if any. */
export function moderationOf(doc: object | null | undefined): ModerationMarks | undefined {
  if (!doc || !('moderation' in doc)) return undefined
  const marks = doc.moderation
  return typeof marks === 'object' && marks !== null ? (marks as ModerationMarks) : undefined
}

/**
 * `{ moderation }` for a raw document that carries marks, `{}` otherwise.
 * Spread it into the object a service's `transformDocument` returns.
 */
export function moderationFieldOf(doc: Record<string, unknown>): { moderation?: ModerationMarks } {
  const data = (doc.data ?? doc) as Record<string, unknown>
  const marks = moderationMarksOf({ ...data, $moderatedBy: doc.$moderatedBy, $moderatedAt: doc.$moderatedAt })
  return Object.keys(marks).length > 0 ? { moderation: marks } : {}
}

/**
 * Prepares the fields of a replace built from a transformed document: the UI's
 * `moderation` object is not a contract property, so it leaves, and the
 * moderator fields it came from go back as `mod` and `modLabel`, unchanged.
 */
export function carryModerationIntoReplace(fields: Record<string, unknown>, doc: object): void {
  delete fields.moderation
  const marks = moderationOf(doc)
  if (marks?.mod !== undefined) fields.mod = marks.mod
  if (marks?.modLabel !== undefined) fields.modLabel = marks.modLabel
}

/** The stored fields a tombstone or other raw replace must keep so the moderator marks survive it. */
export const MODERATION_REPLACE_KEEPS: readonly string[] = ['mod', 'modLabel']

/** The documents this build shows: hidden ones dropped on yap.pr and the official apps, kept on an archival build. */
export function withoutHidden<T extends object>(docs: readonly T[]): T[] {
  return docs.filter((doc) => !dropsHidden(moderationOf(doc)))
}

/** True when this build drops `doc` (hidden, and not an archival build). */
export function isDropped(doc: object | null | undefined): boolean {
  return dropsHidden(moderationOf(doc))
}
