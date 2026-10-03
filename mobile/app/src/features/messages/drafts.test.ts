import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { createMMKV } from 'react-native-mmkv';

import { flushDmDrafts, forgetDmDrafts, takeDraft, useDraft, useDrafts } from './drafts';

const ALICE = 'AliceId111111111111111111111111111111111111';
const CAROL = 'CarolId11111111111111111111111111111111111';

const listeners: ((state: AppStateStatus) => void)[] = [];
// Swapped, not spied: jest-expo's AppState is a mock whose restore would drop its implementation.
const original = AppState.addEventListener;
beforeAll(() => {
  AppState.addEventListener = ((_type: string, listener: (state: AppStateStatus) => void) => {
    listeners.push(listener);
    return { remove: () => undefined };
  }) as unknown as typeof AppState.addEventListener;
});
afterAll(() => {
  AppState.addEventListener = original;
});

const secureItems = jest.requireMock<{ __items: Map<string, string> }>('expo-secure-store').__items;
/** The store opens asynchronously (its key comes from the Keychain): let it. */
const settle = () => act(async () => {});

/** A relaunch: memory is gone; only what was saved on the device is left. */
function relaunch() {
  useDrafts.getState().clearAll();
  expect(useDrafts.getState().byKey).toEqual({});
}

async function draftAfterLaunch(identityId: string, key: string): Promise<string> {
  const { result, unmount } = renderHook(() => useDraft(identityId, key));
  await settle();
  const text = result.current;
  unmount();
  return text;
}

afterEach(async () => {
  useDrafts.getState().clearAll();
  forgetDmDrafts(ALICE);
  forgetDmDrafts(CAROL);
  await settle();
});

describe('DM drafts on the device (PRD DM-04, QA E-20)', () => {
  it('saves unsent text when the app goes to the background, so it survives a kill (QA D-L4i-001)', async () => {
    await draftAfterLaunch(ALICE, 'd:bob');
    useDrafts.getState().set(ALICE, 'd:bob', 'half-typed, do not send');
    // Backgrounded before the 500 ms save, then killed.
    listeners.forEach((listener) => listener('background'));
    relaunch();
    expect(await draftAfterLaunch(ALICE, 'd:bob')).toBe('half-typed, do not send');
  });

  it("keeps it in an encrypted store of its own, never in the app's plain MMKV", async () => {
    useDrafts.getState().set(ALICE, 'd:bob', 'secret words');
    flushDmDrafts();
    await settle();
    expect(secureItems.get('pr.yap.app.engine-keys:yappr.mmkv-key.dm-drafts')).toHaveLength(32);
    const plain = createMMKV({ id: 'yappr' });
    expect(plain.getAllKeys().some((key) => (plain.getString(key) ?? '').includes('secret words'))).toBe(false);
  });

  it('saves on its own half a second after typing stops', async () => {
    jest.useFakeTimers();
    try {
      useDrafts.getState().set(ALICE, 'd:bob', 'typed');
      await act(async () => {
        jest.advanceTimersByTime(600);
      });
    } finally {
      jest.useRealTimers();
    }
    relaunch();
    expect(await draftAfterLaunch(ALICE, 'd:bob')).toBe('typed');
  });

  it("keeps each conversation's and each account's text, and a sent draft goes", async () => {
    useDrafts.getState().set(ALICE, 'd:bob', 'to bob');
    useDrafts.getState().set(ALICE, 'g:team', 'to the team');
    useDrafts.getState().set(CAROL, 'd:bob', 'carol to bob');
    flushDmDrafts();
    await settle();
    relaunch();
    // Text typed after the launch, before the saved drafts were read, wins over them and keeps the rest.
    useDrafts.getState().set(ALICE, 'd:bob', 'newer');
    flushDmDrafts();
    await settle();
    relaunch();
    expect(await draftAfterLaunch(ALICE, 'd:bob')).toBe('newer');
    expect(takeDraft(ALICE, 'g:team')).toBe('to the team');
    expect(await draftAfterLaunch(CAROL, 'd:bob')).toBe('carol to bob');
    flushDmDrafts();
    await settle();
    relaunch();
    expect(await draftAfterLaunch(ALICE, 'g:team')).toBe('');
  });

  it("deletes an account's drafts when it signs out, from memory and from the device (PRD AUTH-11)", async () => {
    useDrafts.getState().set(ALICE, 'd:bob', 'alice draft');
    useDrafts.getState().set(CAROL, 'd:bob', 'carol draft');
    flushDmDrafts();
    await settle();
    forgetDmDrafts(ALICE);
    expect(useDrafts.getState().byKey).toEqual({ [`${CAROL}\u0000d:bob`]: 'carol draft' });
    relaunch();
    expect(await draftAfterLaunch(ALICE, 'd:bob')).toBe('');
    expect(await draftAfterLaunch(CAROL, 'd:bob')).toBe('carol draft');
  });
});
