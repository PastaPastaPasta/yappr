import type { CapabilitiesDTO, TagDTO } from '@engine/api';

import { syncStorage } from '~/state/storage';

import { exploreSegments, shownSegment } from './explore-prefs';
import { addRecent, clearRecent, getRecent, MAX_RECENT, removeRecent } from './recent-searches';
import { countLabel, tagCountLabel, tagDisplay, tagFromParam } from './tags';

describe('tagFromParam', () => {
  it.each([
    ['dash', 'dash', '#dash'],
    ['#Dash', 'dash', '#dash'],
    ['dash_cashtag', 'dash_cashtag', '$DASH'],
    ['$dash', 'dash_cashtag', '$DASH'],
    ['$DASH', 'dash_cashtag', '$DASH'],
    ['web3_dev', 'web3_dev', '#web3_dev'],
  ])('reads %s as %s (%s)', (param, storage, display) => {
    expect(tagFromParam(param)).toEqual({ storage, display });
  });

  it.each([undefined, '', '#', '$', 'two words', 'émoji', 'a'.repeat(64)])('rejects %p', (param) => {
    expect(tagFromParam(param)).toEqual({ storage: '', display: '' });
  });

  it('shows stored tags', () => {
    expect(tagDisplay('btc_cashtag')).toBe('$BTC');
    expect(tagDisplay('mobile')).toBe('#mobile');
  });
});

describe('count labels', () => {
  it('uses the singular for one and compacts big numbers', () => {
    expect(countLabel(1, 'like')).toBe('1 like');
    expect(countLabel(12, 'post')).toBe('12 posts');
    expect(countLabel(2400, 'like')).toBe('2.4K likes');
  });

  it('counts likes where trending ranks them, else posts', () => {
    const tag = (countKind: TagDTO['countKind']): TagDTO => ({
      tag: 'dash',
      kind: 'hashtag',
      display: '#dash',
      count: 3,
      countKind,
    });
    expect(tagCountLabel(tag('likes'))).toBe('3 likes');
    expect(tagCountLabel(tag('posts'))).toBe('3 posts');
  });
});

describe('explore segments', () => {
  const caps = (rankings: boolean, prefixRankings: boolean) =>
    ({ rankings, prefixRankings }) as CapabilitiesDTO;

  it('offers only Trending on v2 (no rankings)', () => {
    expect(exploreSegments(caps(false, false)).map((s) => s.value)).toEqual(['trending']);
    expect(exploreSegments(null).map((s) => s.value)).toEqual(['trending']);
  });

  it('adds Top and Creators where the contract ranks likes', () => {
    expect(exploreSegments(caps(true, true)).map((s) => s.label)).toEqual(['Trending', 'Top', 'Creators']);
    expect(exploreSegments(caps(true, false)).map((s) => s.value)).toEqual(['trending', 'top']);
  });

  it('falls back to Trending when the remembered segment is gone', () => {
    expect(shownSegment('creators', exploreSegments(caps(true, true)))).toBe('creators');
    expect(shownSegment('creators', exploreSegments(caps(false, false)))).toBe('trending');
  });
});

describe('recent searches', () => {
  beforeEach(() => {
    clearRecent('alice');
    clearRecent('bob');
  });

  it('keeps the newest first, each entry once', () => {
    addRecent('alice', { kind: 'query', q: 'dash' });
    addRecent('alice', { kind: 'tag', tag: 'mobile' });
    addRecent('alice', { kind: 'query', q: 'DASH ' });
    expect(getRecent('alice')).toEqual([
      { kind: 'query', q: 'DASH ' },
      { kind: 'tag', tag: 'mobile' },
    ]);
  });

  it('keeps the last 10', () => {
    for (let i = 0; i < 12; i++) addRecent('alice', { kind: 'query', q: `q${i}` });
    const entries = getRecent('alice');
    expect(entries).toHaveLength(MAX_RECENT);
    expect(entries[0]).toEqual({ kind: 'query', q: 'q11' });
  });

  it('is per account and survives a relaunch (MMKV)', () => {
    addRecent('alice', { kind: 'user', id: 'id1', name: 'Bob', username: 'bob' });
    expect(getRecent('bob')).toEqual([]);
    expect(JSON.parse(syncStorage.getItem('yappr.explore.recent.alice') ?? '[]')).toHaveLength(1);
  });

  it('removes one entry, or all', () => {
    addRecent('alice', { kind: 'query', q: 'a' });
    addRecent('alice', { kind: 'query', q: 'b' });
    removeRecent('alice', { kind: 'query', q: 'a' });
    expect(getRecent('alice')).toEqual([{ kind: 'query', q: 'b' }]);
    clearRecent('alice');
    expect(getRecent('alice')).toEqual([]);
    expect(syncStorage.getItem('yappr.explore.recent.alice')).toBeNull();
  });

  it('drops malformed stored entries', () => {
    syncStorage.setItem(
      'yappr.explore.recent.carol',
      JSON.stringify([{ kind: 'query', q: 'ok' }, { kind: 'user', id: 'x' }, { kind: 'nope' }, 'junk']),
    );
    expect(getRecent('carol')).toEqual([{ kind: 'query', q: 'ok' }]);
    syncStorage.setItem('yappr.explore.recent.dave', '{not json');
    expect(getRecent('dave')).toEqual([]);
  });
});
