import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import { Image } from 'expo-image';
import type { ReactNode } from 'react';

import { MediaUrlProvider, type IpfsGateway } from './media-url';
import { MediaGrid } from './post/MediaGrid';
import { MEDIA_SOURCE_TIMEOUT_MS, useMediaSource, useMediaUrlSource } from './use-media-source';

const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const GATEWAYS: IpfsGateway[] = [
  { domain: 'gw-a.example', format: 'path' },
  { domain: 'gw-b.example', format: 'path' },
  { domain: 'gw-c.example', format: 'subdomain' },
];
const A = `https://gw-a.example/ipfs/${CID}`;
const B = `https://gw-b.example/ipfs/${CID}`;
const C = `https://${CID}.gw-c.example`;

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('useMediaSource', () => {
  it('moves to the next source on an error, then fails after the last one', () => {
    const { result } = renderHook(() => useMediaSource(['a', 'b']));
    expect(result.current.uri).toBe('a');
    act(() => result.current.onError());
    expect(result.current.uri).toBe('b');
    expect(result.current.failed).toBe(false);
    act(() => result.current.onError());
    expect(result.current.uri).toBeUndefined();
    expect(result.current.failed).toBe(true);
    expect(result.current.retryable).toBe(true);
  });

  it('gives each source 8 s, then moves on', () => {
    const { result } = renderHook(() => useMediaSource(['a', 'b']));
    act(() => jest.advanceTimersByTime(MEDIA_SOURCE_TIMEOUT_MS - 1));
    expect(result.current.uri).toBe('a');
    act(() => jest.advanceTimersByTime(1));
    expect(result.current.uri).toBe('b');
    // The clock starts over for the next source.
    act(() => jest.advanceTimersByTime(MEDIA_SOURCE_TIMEOUT_MS - 1));
    expect(result.current.failed).toBe(false);
    act(() => jest.advanceTimersByTime(1));
    expect(result.current.failed).toBe(true);
  });

  it('stops the clock once the image loads', () => {
    const { result } = renderHook(() => useMediaSource(['a', 'b']));
    act(() => result.current.onLoad());
    act(() => jest.advanceTimersByTime(MEDIA_SOURCE_TIMEOUT_MS * 3));
    expect(result.current.uri).toBe('a');
    expect(result.current.loaded).toBe(true);
    expect(result.current.failed).toBe(false);
  });

  it('lets a source that keeps receiving bytes keep its turn', () => {
    const { result } = renderHook(() => useMediaSource(['a', 'b']));
    act(() => jest.advanceTimersByTime(7000));
    act(() => result.current.onProgress());
    // 8 s after the first byte, not after the start.
    act(() => jest.advanceTimersByTime(7999));
    expect(result.current.uri).toBe('a');
    act(() => jest.advanceTimersByTime(1));
    expect(result.current.uri).toBe('b');
  });

  it('has no clock for a single source, which has nothing to fall back to', () => {
    const { result } = renderHook(() => useMediaSource(['only']));
    act(() => jest.advanceTimersByTime(MEDIA_SOURCE_TIMEOUT_MS * 5));
    expect(result.current.uri).toBe('only');
    expect(result.current.failed).toBe(false);
    act(() => result.current.onError());
    expect(result.current.failed).toBe(true);
  });

  it('keeps a loaded image when the list changes around the source in view', () => {
    const { result, rerender } = renderHook(({ list }: { list: string[] }) => useMediaSource(list), {
      initialProps: { list: ['a', 'b'] },
    });
    act(() => result.current.onLoad());
    rerender({ list: ['a', 'b', 'c'] });
    act(() => jest.advanceTimersByTime(MEDIA_SOURCE_TIMEOUT_MS * 2));
    expect(result.current.uri).toBe('a');
    expect(result.current.loaded).toBe(true);
    // A list without it starts over.
    rerender({ list: ['x', 'y'] });
    expect(result.current.uri).toBe('x');
    expect(result.current.loaded).toBe(false);
  });

  it('retries from the first source after failing', () => {
    const { result } = renderHook(() => useMediaSource(['a', 'b']));
    act(() => jest.advanceTimersByTime(MEDIA_SOURCE_TIMEOUT_MS));
    act(() => jest.advanceTimersByTime(MEDIA_SOURCE_TIMEOUT_MS));
    expect(result.current.failed).toBe(true);
    act(() => result.current.retry());
    expect(result.current.uri).toBe('a');
    expect(result.current.failed).toBe(false);
    // And the clock runs again.
    act(() => jest.advanceTimersByTime(MEDIA_SOURCE_TIMEOUT_MS));
    expect(result.current.uri).toBe('b');
  });

  it('starts over when the list changes, and has nothing to retry for an empty one', () => {
    const { result, rerender } = renderHook(({ list }: { list: string[] }) => useMediaSource(list), {
      initialProps: { list: ['a', 'b'] },
    });
    act(() => result.current.onError());
    expect(result.current.uri).toBe('b');
    rerender({ list: ['x', 'y'] });
    expect(result.current.uri).toBe('x');
    rerender({ list: [] });
    expect(result.current.uri).toBeUndefined();
    expect(result.current.failed).toBe(true);
    expect(result.current.retryable).toBe(false);
  });

  it('ignores a late error from a source that was already replaced', () => {
    const { result } = renderHook(() => useMediaSource(['a', 'b', 'c']));
    const staleError = result.current.onError;
    act(() => result.current.onError());
    expect(result.current.uri).toBe('b');
    act(() => staleError());
    expect(result.current.uri).toBe('b');
  });
});

describe('useMediaUrlSource', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MediaUrlProvider ipfsGateways={GATEWAYS}>{children}</MediaUrlProvider>
  );

  it('walks the engine gateway list in order, then fails', () => {
    const { result } = renderHook(() => useMediaUrlSource(`ipfs://${CID}`), { wrapper });
    expect(result.current.uri).toBe(A);
    act(() => result.current.onError());
    expect(result.current.uri).toBe(B);
    act(() => jest.advanceTimersByTime(MEDIA_SOURCE_TIMEOUT_MS));
    expect(result.current.uri).toBe(C);
    act(() => result.current.onError());
    expect(result.current.failed).toBe(true);
  });

  it('has one source for a proxied https image', () => {
    const { result } = renderHook(() => useMediaUrlSource('https://x.org/a.png'), { wrapper });
    expect(result.current.uri).toContain('https://wsrv.nl/');
    act(() => result.current.onError());
    expect(result.current.failed).toBe(true);
  });
});

describe('MediaGrid gateway fallback', () => {
  const media = [{ type: 'image' as const, url: `ipfs://${CID}` }];
  const renderGrid = () =>
    render(
      <MediaUrlProvider ipfsGateways={GATEWAYS}>
        <MediaGrid media={media} />
      </MediaUrlProvider>,
    );
  const shown = () => (screen.UNSAFE_getByType(Image).props as { source: { uri: string } }).source.uri;

  it('tries the next gateway after an error and after 8 s', () => {
    renderGrid();
    expect(shown()).toBe(A);
    fireEvent(screen.UNSAFE_getByType(Image), 'error');
    expect(shown()).toBe(B);
    act(() => jest.advanceTimersByTime(MEDIA_SOURCE_TIMEOUT_MS));
    expect(shown()).toBe(C);
  });

  it('ends on the placeholder with Retry, which starts over from the first gateway', () => {
    renderGrid();
    for (let i = 0; i < GATEWAYS.length; i++) fireEvent(screen.UNSAFE_getByType(Image), 'error');
    expect(screen.getByText('Image unavailable')).toBeTruthy();
    expect(screen.UNSAFE_queryByType(Image)).toBeNull();
    fireEvent.press(screen.getByLabelText('Retry loading image'));
    expect(shown()).toBe(A);
    expect(screen.queryByText('Image unavailable')).toBeNull();
  });

  it('offers Retry to a screen reader as an action on the cell, apart from opening it', () => {
    const open = jest.fn();
    render(
      <MediaUrlProvider ipfsGateways={GATEWAYS}>
        <MediaGrid media={media} onMediaPress={open} />
      </MediaUrlProvider>,
    );
    expect(screen.getByLabelText('Image').props.accessibilityActions).toBeUndefined();
    for (let i = 0; i < GATEWAYS.length; i++) fireEvent(screen.UNSAFE_getByType(Image), 'error');
    const cell = screen.getByLabelText('Image');
    expect(cell.props.accessibilityActions).toEqual([{ name: 'retry', label: 'Retry' }]);
    // The default "activate" action opens the viewer and retries nothing.
    fireEvent(cell, 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
    expect(screen.UNSAFE_queryByType(Image)).toBeNull();
    fireEvent(cell, 'accessibilityAction', { nativeEvent: { actionName: 'retry' } });
    expect(shown()).toBe(A);
    expect(open).not.toHaveBeenCalledWith(1);
  });
});
