/**
 * The image viewer's geometry, as worklets (they run on the UI thread inside
 * gesture callbacks) that are also plain functions for the unit tests.
 */

export const MAX_ZOOM = 4;
export const DOUBLE_TAP_ZOOM = 2;
/** A swipe past this share of the width, or this fast, turns the page. */
const PAGE_DISTANCE = 0.25;
const PAGE_VELOCITY = 500;
/** A drag past this many points, or this fast, dismisses. */
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 900;

/** The size an image of `source` takes when fitted ("contain") into `box`. */
export function fittedSize(
  source: { width: number; height: number },
  box: { width: number; height: number },
): { width: number; height: number } {
  if (!source.width || !source.height) return box;
  const ratio = Math.min(box.width / source.width, box.height / source.height);
  return { width: source.width * ratio, height: source.height * ratio };
}

/**
 * Keeps a zoomed image's edge from leaving its side of the screen: the pan
 * on one axis may go as far as the zoomed image overhangs the viewport.
 */
export function clampOffset(offset: number, fitted: number, viewport: number, scale: number): number {
  'worklet';
  const overhang = Math.max(0, (fitted * scale - viewport) / 2);
  return Math.min(overhang, Math.max(-overhang, offset));
}

/** The page a horizontal swipe settles on: one step at most, inside the list. */
export function settlePage(page: number, translation: number, velocity: number, width: number, count: number): number {
  'worklet';
  let target = page;
  if (translation < -width * PAGE_DISTANCE || velocity < -PAGE_VELOCITY) target = page + 1;
  else if (translation > width * PAGE_DISTANCE || velocity > PAGE_VELOCITY) target = page - 1;
  return Math.min(count - 1, Math.max(0, target));
}

/** Whether a vertical drag ends in a dismissal. */
export function shouldDismiss(translation: number, velocity: number): boolean {
  'worklet';
  return Math.abs(translation) > DISMISS_DISTANCE || Math.abs(velocity) > DISMISS_VELOCITY;
}
