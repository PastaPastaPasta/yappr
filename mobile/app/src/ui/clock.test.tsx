import { act, render, screen } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import { RelativeTime } from './RelativeTime';

const MINUTE = 60_000;
// Mid-minute, so a label's boundaries are not the wall clock's.
const START = Date.UTC(2026, 9, 2, 23, 20, 30);

const ago = (ms: number) => new Date(START - ms);

/** The cards' times, in order. */
const labels = () => screen.getAllByTestId('time').map((node) => node.props.children.join(''));

describe('RelativeTime on the shared clock (G-13, QA D-L3i-007)', () => {
  let appStateListeners: ((state: AppStateStatus) => void)[];
  const original = AppState.addEventListener;

  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    appStateListeners = [];
    // Swapped, not spied: jest-expo's AppState is a mock whose restore would drop its implementation.
    AppState.addEventListener = ((_type: string, listener: (state: AppStateStatus) => void) => {
      appStateListeners.push(listener);
      return { remove: () => appStateListeners.splice(appStateListeners.indexOf(listener), 1) };
    }) as unknown as typeof AppState.addEventListener;
  });
  afterEach(() => {
    AppState.addEventListener = original;
    jest.useRealTimers();
  });

  it('keeps a minutes-old time current while the screen stays open', () => {
    render(<RelativeTime testID="time" date={ago(38 * MINUTE + 45_000)} prefix="· " />);
    expect(labels()).toEqual(['· 38m']);

    // It turns 39 minutes old in 15 seconds, not on the wall-clock minute.
    act(() => jest.advanceTimersByTime(14_999));
    expect(labels()).toEqual(['· 38m']);
    act(() => jest.advanceTimersByTime(1));
    expect(labels()).toEqual(['· 39m']);

    act(() => jest.advanceTimersByTime(4 * MINUTE));
    expect(labels()).toEqual(['· 43m']);
  });

  it('runs one timer for every card on screen', () => {
    render(
      <>
        {Array.from({ length: 30 }, (_, i) => (
          // Each turns a minute older 0.1 s before the one above it.
          <RelativeTime key={i} testID="time" date={ago((i + 2) * MINUTE + 57_000 + i * 100)} />
        ))}
      </>,
    );
    expect(labels().slice(0, 3)).toEqual(['2m', '3m', '4m']);
    expect(jest.getTimerCount()).toBe(1);
    // Each card turns on its own boundary.
    act(() => jest.advanceTimersByTime(2850));
    expect(labels().slice(0, 3)).toEqual(['2m', '3m', '5m']);
    expect(jest.getTimerCount()).toBe(1);
    act(() => jest.advanceTimersByTime(150));
    expect(labels().slice(0, 3)).toEqual(['3m', '4m', '5m']);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('ticks each second under a minute, then on each minute of its age', () => {
    render(<RelativeTime testID="time" date={ago(50_000)} />);
    expect(labels()).toEqual(['50s']);
    act(() => jest.advanceTimersByTime(1000));
    expect(labels()).toEqual(['51s']);
    act(() => jest.advanceTimersByTime(9000));
    expect(labels()).toEqual(['1m']);
    // Past the minute the one timer waits for the next minute of its age, not the next second.
    act(() => jest.advanceTimersByTime(1000));
    expect(jest.getTimerCount()).toBe(1);
    act(() => jest.advanceTimersByTime(58_999));
    expect(labels()).toEqual(['1m']);
    act(() => jest.advanceTimersByTime(1));
    expect(labels()).toEqual(['2m']);
  });

  it('stops in the background and catches up on return', () => {
    render(<RelativeTime testID="time" date={ago(10 * MINUTE)} />);
    act(() => appStateListeners.forEach((listener) => listener('background')));
    expect(jest.getTimerCount()).toBe(0);

    jest.setSystemTime(START + 5 * MINUTE);
    act(() => appStateListeners.forEach((listener) => listener('active')));
    expect(labels()).toEqual(['15m']);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('leaves no timer behind once the last card unmounts', () => {
    const { unmount } = render(<RelativeTime testID="time" date={ago(5 * MINUTE)} />);
    expect(jest.getTimerCount()).toBe(1);
    unmount();
    expect(jest.getTimerCount()).toBe(0);
    expect(appStateListeners).toHaveLength(0);
  });

  it('needs no timer for a fixed date or an invalid one', () => {
    render(
      <>
        <RelativeTime testID="time" date={ago(30 * 24 * 60 * MINUTE)} />
        <RelativeTime testID="time" date={new Date(Number.NaN)} />
      </>,
    );
    expect(jest.getTimerCount()).toBe(0);
    expect(labels()[1]).toBe('');
  });
});
