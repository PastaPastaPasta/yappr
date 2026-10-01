import { dehydrate, QueryClient } from '@tanstack/react-query';

import { cacheBuster, persistedQuery, persistOptions } from './query-client';

describe('query persistence', () => {
  it('persists only queries that opt in', async () => {
    const client = new QueryClient();
    await client.prefetchQuery({ queryKey: ['feed'], queryFn: () => 'posts', ...persistedQuery });
    await client.prefetchQuery({ queryKey: ['dm'], queryFn: () => 'secret' });

    const state = dehydrate(client, persistOptions.dehydrateOptions);
    expect(state.queries.map((q) => q.queryKey)).toEqual([['feed']]);
    client.clear();
  });

  it('busts the cache per app version, engine build and network', () => {
    expect(cacheBuster).toBe('1.0.0:no-engine:devnet');
    expect(persistOptions.buster).toBe(cacheBuster);
  });
});
