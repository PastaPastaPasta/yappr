import { act, renderHook } from '@testing-library/react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

import { useStickToNewest } from './stick-to-newest';

/**
 * A scroll event `fromEnd` points above the end of 2000 points of content in
 * an 800-point viewport, released with `velocity` (a drag's end; 0 = no fling).
 */
const scrolled = (fromEnd: number, velocity = 0) =>
  ({
    nativeEvent: {
      contentOffset: { x: 0, y: 2000 - 800 - fromEnd },
      contentSize: { width: 400, height: 2000 },
      layoutMeasurement: { width: 400, height: 800 },
      velocity: { x: 0, y: velocity },
    },
  }) as NativeSyntheticEvent<NativeScrollEvent>;

function setup() {
  const scrollToEnd = jest.fn();
  const native = { scrollToEnd };
  const visible = { end: 0 };
  const target = {
    computeVisibleIndices: jest.fn(() => ({ startIndex: 0, endIndex: visible.end })),
    scrollToIndex: jest.fn(async (_: { index: number; animated?: boolean }) => {}),
    getNativeScrollRef: jest.fn((): typeof native | null => native),
  };
  const list: { current: typeof target | null } = { current: target };
  const hook = renderHook(({ rows, newest }: { rows: number; newest?: string }) => useStickToNewest(list, rows, newest), {
    initialProps: { rows: 0, newest: undefined as string | undefined },
  });
  /** Lets the frame, the scroll to the index and the task after it run. */
  const settle = () => act(() => jest.runAllTimersAsync());
  const show = async (rows: number, newest: string) => {
    hook.rerender({ rows, newest });
    await settle();
  };
  const scroll = hook.result.current.scrollProps;
  return { scrollToEnd, target, visible, list, hook, show, settle, scroll };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('useStickToNewest (QA dm-thread-stale-after-cold-launch)', () => {
  it('scrolls to the newest when history fills in above it after a cold launch, through its index, without animating', async () => {
    const { scrollToEnd, target, visible, show } = setup();
    // A cold launch: only each sender's newest message at first, then the open thread's history.
    visible.end = 1;
    await show(2, 'newest');
    scrollToEnd.mockClear();
    await show(16, 'newest');
    // The newest row is out of FlashList's window: scrolling to its index puts the window right.
    expect(target.scrollToIndex).toHaveBeenCalledWith({ index: 15, animated: false });
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
  });

  it('glides to a message that arrives while the user reads the newest', async () => {
    const { scrollToEnd, visible, show } = setup();
    visible.end = 3;
    await show(3, 'a');
    await show(4, 'b');
    expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: true });
  });

  it('skips the scroll to the index when the newest row is already in view', async () => {
    const { scrollToEnd, target, visible, show } = setup();
    visible.end = 9;
    await show(10, 'a');
    expect(target.scrollToIndex).not.toHaveBeenCalled();
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('leaves a user reading older messages where they are, until they are back at the end', async () => {
    const { scrollToEnd, show, scroll } = setup();
    await show(10, 'a');
    act(() => {
      scroll.onScrollBeginDrag();
      scroll.onScrollEndDrag(scrolled(900));
    });
    scrollToEnd.mockClear();
    await show(60, 'a'); // an older page
    await show(61, 'b'); // a new message
    expect(scrollToEnd).not.toHaveBeenCalled();

    // A drag and fling that come to rest near the end pin it again.
    act(() => {
      scroll.onScrollBeginDrag();
      scroll.onScrollEndDrag(scrolled(600, -2));
      scroll.onMomentumScrollEnd(scrolled(100));
    });
    await show(62, 'c');
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('never moves the list while a fling is still under way, even if it was let go near the end (review: flick up loads a page)', async () => {
    const { scrollToEnd, target, show, settle, scroll } = setup();
    await show(50, 'a');
    scrollToEnd.mockClear();
    target.scrollToIndex.mockClear();
    // A quick flick up: let go within the end zone, with speed.
    act(() => {
      scroll.onScrollBeginDrag();
      scroll.onScrollEndDrag(scrolled(250, -3));
    });
    // The fling reaches the top threshold and an older page lands, then a message.
    await show(100, 'a');
    await show(101, 'b');
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(target.scrollToIndex).not.toHaveBeenCalled();
    // It comes to rest far up: still left alone.
    act(() => scroll.onMomentumScrollEnd(scrolled(5000)));
    await show(102, 'c');
    await settle();
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('never moves the list while the finger is down, and catches up if it is let go at the end', async () => {
    const { scrollToEnd, show, settle, scroll } = setup();
    await show(10, 'a');
    scrollToEnd.mockClear();
    act(() => scroll.onScrollBeginDrag());
    await show(11, 'b');
    expect(scrollToEnd).not.toHaveBeenCalled();
    act(() => scroll.onScrollEndDrag(scrolled(50)));
    await settle();
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: true });
  });

  it("ignores the end of its own animated scroll (iOS sends one), so a list that grew meanwhile stays pinned", async () => {
    const { scrollToEnd, show, scroll } = setup();
    await show(10, 'a');
    // iOS reports where this hook's own scroll stopped, with the content already taller.
    act(() => scroll.onMomentumScrollEnd(scrolled(900)));
    scrollToEnd.mockClear();
    await show(11, 'b');
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('a drag let go without speed decides at once; the momentum end Android sends after it changes nothing', async () => {
    const { scrollToEnd, show, scroll } = setup();
    await show(10, 'a');
    act(() => {
      scroll.onScrollBeginDrag();
      scroll.onScrollEndDrag(scrolled(900));
      scroll.onMomentumScrollEnd(scrolled(0));
    });
    scrollToEnd.mockClear();
    await show(11, 'b');
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('pins again for an action that shows the newest (a send, the keyboard), and scrolls once for both', async () => {
    const { scrollToEnd, hook, show, settle, scroll } = setup();
    await show(10, 'a');
    act(() => {
      scroll.onScrollBeginDrag();
      scroll.onScrollEndDrag(scrolled(900));
    });
    scrollToEnd.mockClear();
    // A send: the screen asks for the newest, and the sent message's row appears in the same frame.
    act(() => hook.result.current.scrollToNewest());
    hook.rerender({ rows: 11, newest: 'b' });
    await settle();
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: true });
  });

  it('runs one scroll at a time: a request while one is on its way follows it', async () => {
    const { scrollToEnd, target, show, settle } = setup();
    let release = () => {};
    target.scrollToIndex.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    await show(5, 'a');
    await show(6, 'b');
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(target.scrollToIndex).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await settle();
    expect(scrollToEnd).toHaveBeenCalledTimes(2);
  });

  it('does not touch the list once it has unmounted mid-scroll (FlashList scrollToEnd would throw)', async () => {
    const { scrollToEnd, target, list, hook, show, settle } = setup();
    let release = () => {};
    target.scrollToIndex.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    await show(5, 'a');
    hook.unmount();
    list.current = null;
    target.getNativeScrollRef.mockReturnValue(null);
    await act(async () => release());
    await settle();
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('does nothing for an empty conversation', async () => {
    const { scrollToEnd, hook, settle } = setup();
    hook.rerender({ rows: 0, newest: undefined });
    await settle();
    expect(scrollToEnd).not.toHaveBeenCalled();
  });
});
