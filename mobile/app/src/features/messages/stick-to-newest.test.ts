import { act, renderHook } from '@testing-library/react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

import { useStickToNewest } from './stick-to-newest';

/** A scroll that ended `fromEnd` points above the end of 2000 points of content in an 800-point viewport. */
const scrolled = (fromEnd: number) =>
  ({
    nativeEvent: {
      contentOffset: { x: 0, y: 2000 - 800 - fromEnd },
      contentSize: { width: 400, height: 2000 },
      layoutMeasurement: { width: 400, height: 800 },
    },
  }) as NativeSyntheticEvent<NativeScrollEvent>;

function setup() {
  const scrollToEnd = jest.fn();
  const list = { current: { scrollToEnd } };
  const hook = renderHook(({ rows, newest }: { rows: number; newest?: string }) => useStickToNewest(list, rows, newest), {
    initialProps: { rows: 0, newest: undefined as string | undefined },
  });
  const show = (rows: number, newest: string) => {
    hook.rerender({ rows, newest });
    act(() => jest.runOnlyPendingTimers());
  };
  return { scrollToEnd, hook, show };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('useStickToNewest (QA dm-thread-stale-after-cold-launch)', () => {
  it('scrolls to the newest when history fills in above it after a cold launch, without animating', () => {
    const { scrollToEnd, show } = setup();
    // A cold launch: only each sender's newest message at first, then the open thread's history.
    show(2, 'newest');
    scrollToEnd.mockClear();
    show(16, 'newest');
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
  });

  it('glides to a message that arrives while the user reads the newest', () => {
    const { scrollToEnd, show } = setup();
    show(3, 'a');
    show(4, 'b');
    expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: true });
  });

  it('leaves a user reading older messages where they are, until they are back at the end', () => {
    const { scrollToEnd, hook, show } = setup();
    show(10, 'a');
    act(() => hook.result.current.scrollProps.onScrollEndDrag(scrolled(900)));
    scrollToEnd.mockClear();
    show(60, 'a'); // an older page
    show(61, 'b'); // a new message
    expect(scrollToEnd).not.toHaveBeenCalled();

    // A fling that ends near the end pins it again.
    act(() => hook.result.current.scrollProps.onMomentumScrollEnd(scrolled(100)));
    show(62, 'c');
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('pins again for an action that shows the newest (a send)', () => {
    const { scrollToEnd, hook, show } = setup();
    show(10, 'a');
    act(() => hook.result.current.scrollProps.onScrollEndDrag(scrolled(900)));
    act(() => hook.result.current.pin());
    scrollToEnd.mockClear();
    show(11, 'b');
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an empty conversation', () => {
    const { scrollToEnd, hook } = setup();
    hook.rerender({ rows: 0, newest: undefined });
    act(() => jest.runOnlyPendingTimers());
    expect(scrollToEnd).not.toHaveBeenCalled();
  });
});
