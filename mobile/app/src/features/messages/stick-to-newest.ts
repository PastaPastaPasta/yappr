import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

/** The part of a list ref this needs (FlashList's). */
export interface ScrollsToEnd {
  scrollToEnd(params?: { animated?: boolean }): unknown;
}

/** This share of the viewport from the end still counts as reading the newest (as `autoscrollToBottomThreshold`). */
const AT_END_SHARE = 0.2;

function atEnd({ contentOffset, contentSize, layoutMeasurement }: NativeScrollEvent): boolean {
  return contentOffset.y + layoutMeasurement.height >= contentSize.height - layoutMeasurement.height * AT_END_SHARE;
}

/**
 * Keeps a conversation on its newest message while the user reads there
 * (PRD DM-03: it opens at the newest and stays live).
 *
 * FlashList's own `maintainVisibleContentPosition` can't be relied on for
 * this. A thread opened after a cold launch first holds only each sender's
 * newest message (the engine loads the rest of the history once it is
 * open), so it starts shorter than the screen. When the history arrives,
 * FlashList 2 leaves its window out of step with the content
 * (Shopify/flash-list#2050, open): the newest bubbles stay blank, as if they
 * had never been sent, until the user scrolls (QA
 * dm-thread-stale-after-cold-launch). A scroll to the end puts the window
 * right, so the list scrolls there itself whenever its rows change while it
 * is pinned.
 *
 * Pinned from the start. Only the user's own scroll unpins it (a drag or a
 * fling that ends away from the end), and one back to the end pins it again,
 * so reading older messages is never interrupted. `pin()` pins it for an
 * action that shows the newest itself (a send, the keyboard opening).
 */
export function useStickToNewest(list: RefObject<ScrollsToEnd | null>, rows: number, newestId: string | undefined) {
  const pinned = useRef(true);
  const shownNewest = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!pinned.current || rows === 0) return undefined;
    // A new message at the end glides in; a first page, or history filled in above, doesn't move the view.
    const arrived = shownNewest.current !== undefined && shownNewest.current !== newestId;
    shownNewest.current = newestId;
    // After the frame that lays the new rows out.
    const frame = requestAnimationFrame(() => {
      list.current?.scrollToEnd({ animated: arrived });
    });
    return () => cancelAnimationFrame(frame);
  }, [list, rows, newestId]);

  const onScrollEnded = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    pinned.current = atEnd(event.nativeEvent);
  }, []);
  const pin = useCallback(() => {
    pinned.current = true;
  }, []);

  return { pin, scrollProps: { onScrollEndDrag: onScrollEnded, onMomentumScrollEnd: onScrollEnded } };
}
