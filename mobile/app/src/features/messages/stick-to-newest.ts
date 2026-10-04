import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

/** The part of a list ref this needs (FlashList's). */
export interface EndScrollable {
  scrollToIndex(params: { index: number; animated?: boolean }): Promise<void>;
  computeVisibleIndices(): { startIndex: number; endIndex: number };
  getNativeScrollRef(): { scrollToEnd(options?: { animated?: boolean }): void } | null;
}

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

/** This share of the viewport from the end still counts as reading the newest (as `autoscrollToBottomThreshold`). */
const AT_END_SHARE = 0.2;

function atEnd({ contentOffset, contentSize, layoutMeasurement }: NativeScrollEvent): boolean {
  return contentOffset.y + layoutMeasurement.height >= contentSize.height - layoutMeasurement.height * AT_END_SHARE;
}

/**
 * A drag released with speed goes on as a fling, which ends in a momentum
 * end event: on iOS only then (the scroll view decelerates exactly when the
 * release had a velocity); Android sends momentum events after every drag.
 */
function flingFollows({ velocity }: NativeScrollEvent): boolean {
  return velocity !== undefined && (velocity.x !== 0 || velocity.y !== 0);
}

/** A task later, as FlashList's own `scrollToEnd` waits after its scroll to the index. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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
 * dm-thread-stale-after-cold-launch). A scroll to the index of the newest
 * row puts the window right, so the list scrolls there itself whenever its
 * rows change while it is pinned.
 *
 * Pinned from the start. The user's own scroll takes over from the moment
 * their finger starts it until it comes to rest, fling included: nothing
 * moves the list meanwhile. Where it comes to rest decides: away from the
 * end unpins it, and back at the end pins it again (catching up on rows
 * that changed meanwhile). Scrolls this hook starts itself never decide.
 * `scrollToNewest()` pins it for an action that shows the newest (a send,
 * the keyboard opening).
 */
export function useStickToNewest(list: RefObject<EndScrollable | null>, rows: number, newestId: string | undefined) {
  const pinned = useRef(true);
  /** The user's own scroll is under way: from their drag's start until it, or the fling after it, comes to rest. */
  const userScrolling = useRef(false);
  /** Rows changed while the user's scroll was under way. */
  const missed = useRef(false);
  const shownNewest = useRef<string | undefined>(undefined);
  const lastRows = useRef(0);
  const mounted = useRef(true);
  const frame = useRef<number | undefined>(undefined);
  /** The scroll still to run (animated or not), or none. Requests while one is pending or running join it. */
  const pending = useRef<boolean | undefined>(undefined);
  const running = useRef(false);

  const scrollOnce = useCallback(
    async (animated: boolean) => {
      const last = lastRows.current - 1;
      const target = list.current;
      if (!target || last < 0) return;
      if (target.computeVisibleIndices().endIndex < last) await target.scrollToIndex({ index: last, animated });
      await nextTask();
      // Not FlashList's scrollToEnd: its last step runs in a timer that throws once the list has unmounted.
      if (!mounted.current || userScrolling.current) return;
      list.current?.getNativeScrollRef()?.scrollToEnd({ animated });
    },
    [list],
  );

  const run = useCallback(async () => {
    running.current = true;
    try {
      while (pending.current !== undefined && mounted.current) {
        const animated = pending.current;
        pending.current = undefined;
        if (userScrolling.current) {
          missed.current = true;
          return;
        }
        if (pinned.current) await scrollOnce(animated);
      }
    } finally {
      running.current = false;
    }
  }, [scrollOnce]);

  /** One scroll to the end, after the frame that lays the rows out; overlapping requests make one scroll. */
  const toEnd = useCallback(
    (animated: boolean) => {
      pending.current = (pending.current ?? false) || animated;
      if (running.current || frame.current !== undefined) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = undefined;
        run().catch(() => undefined);
      });
    },
    [run],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
      pending.current = undefined;
    };
  }, []);

  useEffect(() => {
    lastRows.current = rows;
    if (rows === 0 || !pinned.current) return;
    // A new message at the end glides in; a first page, or history filled in above, doesn't move the view.
    const arrived = shownNewest.current !== undefined && shownNewest.current !== newestId;
    shownNewest.current = newestId;
    if (userScrolling.current) missed.current = true;
    else toEnd(arrived);
  }, [rows, newestId, toEnd]);

  const settle = useCallback(
    (event: ScrollEvent) => {
      userScrolling.current = false;
      pinned.current = atEnd(event.nativeEvent);
      if (pinned.current && missed.current) toEnd(true);
      missed.current = false;
    },
    [toEnd],
  );

  const onScrollBeginDrag = useCallback(() => {
    userScrolling.current = true;
  }, []);
  const onScrollEndDrag = useCallback(
    (event: ScrollEvent) => {
      // A fling decides where it comes to rest.
      if (!flingFollows(event.nativeEvent)) settle(event);
    },
    [settle],
  );
  const onMomentumScrollEnd = useCallback(
    (event: ScrollEvent) => {
      // iOS also ends this hook's own animated scrolls with one; only the user's scroll decides.
      if (userScrolling.current) settle(event);
    },
    [settle],
  );

  const scrollToNewest = useCallback(
    (animated = true) => {
      // The user acted (sent, opened the keyboard): whatever their scroll was doing, they want the newest.
      userScrolling.current = false;
      missed.current = false;
      pinned.current = true;
      toEnd(animated);
    },
    [toEnd],
  );

  return { scrollToNewest, scrollProps: { onScrollBeginDrag, onScrollEndDrag, onMomentumScrollEnd } };
}
