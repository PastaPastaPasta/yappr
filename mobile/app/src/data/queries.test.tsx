import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { queryClient } from '~/state/query-client';

import { fetchEngineQuery, useEngineInfiniteQuery, useEngineQuery } from './queries';
import { fakeEngine } from './testing/fake-engine';

/** The signals the data layer handed the engine (`engine.withSignal`), in order. */
const mockSignals: AbortSignal[] = [];
jest.mock('~/engine', () => {
  const fake = jest.requireActual('~/data/testing/fake-engine').engineModule;
  return {
    ...fake,
    engine: {
      ...fake.engine,
      withSignal: (signal: AbortSignal) => {
        mockSignals.push(signal);
        return fake.engine.api;
      },
    },
  };
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  mockSignals.length = 0;
  fakeEngine.reset();
  queryClient.clear();
});

describe('engine reads end with their screen (ENGINE.md §4.6, MARCH-4)', () => {
  it('cancels a read in flight when its screen unmounts', async () => {
    fakeEngine.method('posts.get').mockReturnValue(new Promise(() => undefined));
    const { unmount } = renderHook(() => useEngineQuery(['post', 'p'], (api) => api.posts.get('p')), { wrapper });
    await waitFor(() => expect(mockSignals).toHaveLength(1));
    expect(mockSignals[0].aborted).toBe(false);
    unmount();
    await waitFor(() => expect(mockSignals[0].aborted).toBe(true));
  });

  it('cancels a page read in flight when its screen unmounts', async () => {
    fakeEngine.method('explore.searchPosts').mockReturnValue(new Promise(() => undefined));
    const { unmount } = renderHook(
      () => useEngineInfiniteQuery(['search', 'old'], (api) => api.explore.searchPosts('old').then((items) => ({ items, cursor: null, hasMore: false }))),
      { wrapper },
    );
    await waitFor(() => expect(mockSignals).toHaveLength(1));
    unmount();
    await waitFor(() => expect(mockSignals[0].aborted).toBe(true));
  });

  it('reads afresh when an imperative fetch joined a read its screen then cancelled', async () => {
    let answer!: (value: null) => void;
    fakeEngine
      .method('posts.get')
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const { unmount } = renderHook(() => useEngineQuery(['post', 'joined'], (api) => api.posts.get('joined')), { wrapper });
    await waitFor(() => expect(mockSignals).toHaveLength(1));
    // Joins the screen's read in flight.
    const fetched = fetchEngineQuery(['post', 'joined'], (api) => api.posts.get('joined'));
    unmount();
    await waitFor(() => expect(fakeEngine.method('posts.get')).toHaveBeenCalledTimes(2));
    answer(null);
    await expect(fetched).resolves.toBeNull();
  });

  it('leaves a read that finished alone', async () => {
    fakeEngine.method('posts.get').mockResolvedValue(null);
    const { result, unmount } = renderHook(() => useEngineQuery(['post', 'q'], (api) => api.posts.get('q')), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    unmount();
    expect(mockSignals[0].aborted).toBe(false);
  });
});
