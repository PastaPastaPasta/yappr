/**
 * A post's repost count as a card read it, with the viewer's own repost as
 * that read found it. The count holds at most one repost by the viewer (one
 * slot per viewer and post), so the card shows the count with the viewer's
 * repost as it stands now in place of the one the count was read with: a
 * repost or undo on any card, a refused write and a refresh mid-write all
 * come out right without knowing which writes the count had seen.
 */
export interface CountBase {
  count: number
  /** Whether the viewer's repost was in `count`; undefined until known. */
  own?: boolean
}

/** The count to show, with `ownNow` (undefined while unknown) in place of the base's own repost. */
export function countWithOwn(base: CountBase, ownNow: boolean | undefined): number {
  if (base.own === undefined || ownNow === undefined) return base.count
  return Math.max(0, base.count - Number(base.own) + Number(ownNow))
}
