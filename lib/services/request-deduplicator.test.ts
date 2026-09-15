import { describe, expect, it, vi } from 'vitest';
import { RequestDeduplicator } from './sdk-helpers';

describe('read deduplication without a post-settlement cache', () => {
  it('shares simultaneous reads and reads again immediately after settlement', async () => {
    const pending = new RequestDeduplicator<string, number>(0);
    let finish: (value: number) => void = () => { throw new Error('not started'); };
    const read = vi.fn(() => new Promise<number>(resolve => { finish = resolve; }));
    const first = pending.dedupe('owner', read);
    const second = pending.dedupe('owner', read);
    expect(read).toHaveBeenCalledTimes(1);
    finish(1);
    expect(await Promise.all([first, second])).toEqual([1, 1]);
    const third = pending.dedupe('owner', read);
    expect(read).toHaveBeenCalledTimes(2);
    finish(2);
    expect(await third).toBe(2);
  });

  it('never shares different owners or caches failures', async () => {
    const pending = new RequestDeduplicator<string, number>(0);
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(3);
    await expect(pending.dedupe('a', read)).rejects.toThrow('offline');
    expect(await pending.dedupe('a', read)).toBe(3);
    expect(await pending.dedupe('b', read)).toBe(3);
    expect(read).toHaveBeenCalledTimes(3);
  });
});
