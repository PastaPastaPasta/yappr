import { act } from '@testing-library/react-native';

import { syncStorage } from '~/state/storage';

import { accountKey, DEFAULT_PREFS, toHomePrefs, useHomePrefsStore } from './home-prefs';

const prefsOf = (account: string) => useHomePrefsStore.getState().accounts[account] ?? DEFAULT_PREFS;

beforeEach(() => act(() => useHomePrefsStore.setState({ accounts: {} })));

describe('home prefs', () => {
  it('keeps each account’s tab and sort apart (PRD FEED-03)', () => {
    act(() => useHomePrefsStore.getState().set('alice', { tab: 'following', sort: 'top' }));
    act(() => useHomePrefsStore.getState().set(accountKey(null), { window: 'today' }));

    expect(prefsOf('alice')).toEqual({ tab: 'following', sort: 'top', window: 'all' });
    expect(prefsOf('signed-out')).toEqual({ tab: 'forYou', sort: 'recent', window: 'today' });
    expect(prefsOf('bob')).toEqual(DEFAULT_PREFS);
  });

  it('persists to MMKV', () => {
    act(() => useHomePrefsStore.getState().set('alice', { tab: 'following' }));
    const stored = JSON.parse(syncStorage.getItem('yappr.home') ?? 'null') as { state: unknown };
    expect(stored.state).toEqual({ accounts: { alice: { tab: 'following', sort: 'recent', window: 'all' } } });
  });

  it('remembers at most 20 accounts, dropping the least recently changed', () => {
    for (let i = 0; i < 25; i += 1) act(() => useHomePrefsStore.getState().set(`id${i}`, { tab: 'following' }));
    const accounts = Object.keys(useHomePrefsStore.getState().accounts);
    expect(accounts).toHaveLength(20);
    expect(accounts).not.toContain('id0');
    expect(accounts.at(-1)).toBe('id24');
  });

  it('trusts only known values from storage', () => {
    expect(toHomePrefs({ tab: 'following', sort: 'top', window: 'today' })).toEqual({
      tab: 'following',
      sort: 'top',
      window: 'today',
    });
    expect(toHomePrefs({ tab: 'explore', sort: 1, window: 'week' })).toEqual(DEFAULT_PREFS);
    expect(toHomePrefs('junk')).toEqual(DEFAULT_PREFS);
  });
});
