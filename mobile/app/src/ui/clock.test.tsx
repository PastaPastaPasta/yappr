import { act, render, screen } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import { RelativeTime } from './RelativeTime';

const MINUTE = 60_000;
// Mid-minute, so the first minute tick is half a minute away.
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

    act(() => jest.advanceTimersByTime(30_000));
    expect(labels()).toEqual(['· 39m']);

    act(() => jest.advanceTimersByTime(4 * MINUTE));
    expect(labels()).toEqual(['· 43m']);
  });

  it('runs one timer for every card on screen', () => {
    render(
      <>
        {Array.from({ length: 30 }, (_, i) => (
          <RelativeTime key={i} testID="time" date={ago((i + 2) * MINUTE + 45_000)} />
        ))}
      </>,
    );
    expect(jest.getTimerCount()).toBe(1);
    act(() => jest.advanceTimersByTime(30_000));
    expect(labels().slice(0, 3)).toEqual(['3m', '4m', '5m']);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('ticks each second under a minute, then moves to the minute clock', () => {
    render(<RelativeTime testID="time" date={ago(50_000)} />);
    expect(labels()).toEqual(['50s']);
    act(() => jest.advanceTimersByTime(1000));
    expect(labels()).toEqual(['51s']);
    act(() => jest.advanceTimersByTime(9000));
    expect(labels()).toEqual(['1m']);
    // Past the minute the one timer waits for the next wall-clock minute, not the next second.
    act(() => jest.advanceTimersByTime(1000));
    expect(jest.getTimerCount()).toBe(1);
    act(() => jest.advanceTimersByTime(58_000));
    expect(labels()).toEqual(['1m']);
    // Nothing re-renders between minute ticks, even once the label is due to change...
    act(() => jest.advanceTimersByTime(10_000));
    expect(labels()).toEqual(['1m']);
    // ...and the next wall-clock minute brings it up to date.
    act(() => jest.advanceTimersByTime(11_000));
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
