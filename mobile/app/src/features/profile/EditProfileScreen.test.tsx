import type { CapabilitiesDTO, PostDTO, ProfileDTO, SessionDTO, WriteTicket } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { ReactElement } from 'react';
import { Alert, type AlertButton } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { queryKeys } from '~/data/keys';
import { useSessionStore } from '~/data/session';
import { advance, fakeEngine, ticket } from '~/data/testing/fake-engine';
import { resetWriteTracking, runWrite } from '~/data/writes';
import { queryClient } from '~/state/query-client';
import { fixturePost } from '~/ui/post/fixtures';
import { useToastStore } from '~/ui/toast';

import { BookmarksScreen } from './BookmarksScreen';
import { EditProfileScreen } from './EditProfileScreen';
import { profileUpdateWrite } from './profile-writes';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
/** The screen's navigation listeners (`beforeRemove`), so a test can try to leave. */
const mockListeners: Record<string, (event: unknown) => void> = {};

/** Tries to leave the screen; true when the screen held it back to ask. */
function tryLeave(): boolean {
  const preventDefault = jest.fn();
  act(() => mockListeners.beforeRemove?.({ preventDefault, data: { action: { type: 'GO_BACK' } } }));
  return preventDefault.mock.calls.length > 0;
}

// Stack.Screen renders its title and header buttons here, so the tests can read and press them.
jest.mock('expo-router', () => {
  const { Text, View } = jest.requireActual('react-native');
  return {
    router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) },
    Stack: {
      Screen: ({
        options,
      }: {
        options?: { title?: string; headerLeft?: () => ReactElement; headerRight?: () => ReactElement };
      }) => (
        <View>
          <Text testID="screen-title">{options?.title}</Text>
          {options?.headerLeft?.()}
          {options?.headerRight?.()}
        </View>
      ),
    },
    useNavigation: () => ({
      addListener: (event: string, listener: (e: unknown) => void) => {
        mockListeners[event] = listener;
        return () => undefined;
      },
      dispatch: jest.fn(),
    }),
    useFocusEffect: jest.fn(),
  };
});
jest.mock('@shopify/flash-list/dist/recyclerview/utils/measureLayout', () => {
  const layout = { x: 0, y: 0, width: 400, height: 900 };
  return {
    ...jest.requireActual('@shopify/flash-list/dist/recyclerview/utils/measureLayout'),
    measureParentSize: () => layout,
    measureFirstChildLayout: () => layout,
    measureItemLayout: () => ({ x: 0, y: 0, width: 400, height: 100 }),
  };
});

const VIEWER = 'as7CNcWaqWqJND2pxfnKjc6da6AhWVpsXGR92yraATc';
const viewer: SessionDTO = {
  identityId: VIEWER,
  network: 'devnet',
  username: 'jana',
  credits: 1n,
  hasEncryptionKey: true,
  method: 'key',
};
const PROFILE: ProfileDTO = {
  id: VIEWER,
  username: 'jana',
  usernames: ['jana'],
  displayName: 'Jana Abara',
  avatar: { uri: null, dicebear: { style: 'thumbs', seed: VIEWER } },
  hasProfile: true,
  bio: 'Film mostly.',
  stats: { posts: 1, followers: 3, following: 7 },
};

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

function renderScreen(element: ReactElement) {
  return render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
      <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>
    </SafeAreaProvider>,
  );
}

beforeAll(() => {
  notifyManager.setScheduler((callback) => callback());
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
});
afterEach(() => queryClient.clear());

let alert: { title: string; press: (text: string) => void } | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
  // A write a test left pending would keep its key busy for the next.
  resetWriteTracking();
  queryClient.clear();
  fakeEngine.setStatus({
    state: 'ready',
    info: {
      capabilities: {
        profileLimits: { displayName: 25, bio: 140 },
        dashpayProfile: true,
        repostable: { post: true, reply: true },
        bookmarkable: { post: true, reply: false },
      } as CapabilitiesDTO,
      avatarStyles: { styles: [{ id: 'thumbs', label: 'Thumbs' }], defaultStyle: 'thumbs', seedMaxLength: 64 },
    },
  });
  useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
  useToastStore.setState({ current: null });
  alert = null;
  jest.spyOn(Alert, 'alert').mockImplementation((title, _message, buttons?: AlertButton[]) => {
    alert = { title, press: (text) => buttons?.find((b) => b.text === text)?.onPress?.() };
  });
});

describe('EditProfileScreen', () => {
  it('shows the retry state, not the form, when the read of a stale copy fails', async () => {
    // A copy persisted ten minutes ago, then the read this screen makes fails.
    queryClient.setQueryData(queryKeys.profile.detail(VIEWER), PROFILE, { updatedAt: Date.now() - 600_000 });
    fakeEngine.method('profiles.get').mockRejectedValue(new Error('offline'));
    renderScreen(<EditProfileScreen />);
    await flush();

    expect(fakeEngine.method('profiles.get')).toHaveBeenCalled();
    expect(screen.queryByTestId('edit-name')).toBeNull();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('lists every field in one list, saves only the change, and closes once confirmed (#20)', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
    const pending = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
    fakeEngine.method('profiles.update').mockResolvedValue(pending);
    renderScreen(<EditProfileScreen />);
    await flush();

    // No sections named after the documents: one list, with a footnote under Bio where DashPay holds them.
    expect(screen.queryByText(/DashPay profile|Yappr profile/i)).toBeNull();
    expect(screen.getByTestId('edit-dashpay-note')).toHaveTextContent(
      'Your name and bio also show in other Dash apps, like DashPay.',
    );
    expect(screen.getByTestId('edit-save')).toBeDisabled();

    fireEvent.changeText(screen.getByTestId('edit-pronouns'), 'she/her');
    expect(screen.getByTestId('edit-save')).toBeEnabled();
    await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
    expect(fakeEngine.method('profiles.update')).toHaveBeenCalledWith({ pronouns: 'she/her' });
    expect(screen.getByTestId('edit-saving')).toBeTruthy();

    act(() => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
    expect(useToastStore.getState().current?.message).toBe('Profile updated!');
    expect(router.back).toHaveBeenCalled();
  });

  it('opens the profile it edited when a saved form has nothing under it (a cold link)', async () => {
    jest.mocked(router.canGoBack).mockReturnValue(false);
    try {
      fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
      const pending = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
      fakeEngine.method('profiles.update').mockResolvedValue(pending);
      renderScreen(<EditProfileScreen />);
      await flush();
      fireEvent.changeText(screen.getByTestId('edit-pronouns'), 'she/her');
      await act(async () => fireEvent.press(screen.getByTestId('edit-save')));

      act(() => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
      expect(router.back).not.toHaveBeenCalled();
      expect(router.replace).toHaveBeenCalledWith('/profile');
    } finally {
      jest.mocked(router.canGoBack).mockReturnValue(true);
    }
  });

  it('keeps the form as it was while saving in the render that closes it (Android crash, profile-save-crash-dark)', async () => {
    // Re-enabling the fields as the modal closes moved the inputs between native parents inside
    // a screen Android was animating out: "addViewAt: … The specified child already has a parent".
    fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
    const pending = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
    fakeEngine.method('profiles.update').mockResolvedValue(pending);
    renderScreen(<EditProfileScreen />);
    await flush();
    fireEvent.changeText(screen.getByTestId('edit-bio'), 'Film and food.');
    await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
    const fields = ['edit-name', 'edit-bio', 'edit-pronouns', 'edit-location', 'edit-website', 'edit-banner'];
    for (const id of fields) expect(screen.getByTestId(id)).toBeDisabled();

    act(() => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
    expect(router.back).toHaveBeenCalled();
    for (const id of fields) expect(screen.getByTestId(id)).toBeDisabled();
    expect(screen.getByTestId('edit-saving')).toBeTruthy();
    expect(screen.queryByTestId('edit-save')).toBeNull();
    expect(screen.getByTestId('edit-cancel')).toBeDisabled();
  });

  it('says just "Saving…" while a dev save writes its two documents (#20)', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
    const pending = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
    fakeEngine.method('profiles.update').mockResolvedValue(pending);
    renderScreen(<EditProfileScreen />);
    await flush();
    expect(screen.getByTestId('screen-title')).toHaveTextContent('Edit profile');

    fireEvent.changeText(screen.getByTestId('edit-bio'), 'Film and food.');
    fireEvent.changeText(screen.getByTestId('edit-pronouns'), 'she/her');
    await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
    expect(screen.getByTestId('screen-title')).toHaveTextContent('Saving…', { exact: true });
    act(() => fakeEngine.emit('write.status', advance(pending, { progress: { done: 0, total: 2 } })));
    expect(screen.getByTestId('screen-title')).toHaveTextContent('Saving…', { exact: true });
    act(() => fakeEngine.emit('write.status', advance(pending, { progress: { done: 1, total: 2 } })));
    expect(screen.getByTestId('screen-title')).toHaveTextContent('Saving…', { exact: true });
  });

  it('names the fields that did not save when the second document fails (#20)', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
    const pending = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
    fakeEngine.method('profiles.update').mockResolvedValue(pending);
    renderScreen(<EditProfileScreen />);
    await flush();

    fireEvent.changeText(screen.getByTestId('edit-bio'), 'Film and food.');
    fireEvent.changeText(screen.getByTestId('edit-pronouns'), 'she/her');
    fireEvent.changeText(screen.getByTestId('edit-website'), 'https://jana.film');
    await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
    // The DashPay profile is written; the Yappr profile, second, fails.
    const halfway = advance(pending, { progress: { done: 1, total: 2 } });
    act(() => fakeEngine.emit('write.status', halfway));
    act(() =>
      fakeEngine.emit(
        'write.status',
        advance(halfway, {
          state: 'failed',
          retryable: true,
          error: { code: 'NETWORK', consensusCode: null, outcome: 'refused', retryable: true, userMessage: 'Network error.' },
        }),
      ),
    );
    expect(useToastStore.getState().current?.message).toBe("Couldn't save pronouns and website. Try again.");
    // The bio went in the DashPay profile, which saved: it stays on the profile; the rest is undone.
    expect(queryClient.getQueryData<ProfileDTO>(queryKeys.profile.detail(VIEWER))).toMatchObject({ bio: 'Film and food.' });
    expect(queryClient.getQueryData<ProfileDTO>(queryKeys.profile.detail(VIEWER))).not.toHaveProperty('pronouns');
  });

  it('sends one update for a double-tapped Save, even after the first confirms (SR-14)', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
    const pending = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
    let answer: (t: typeof pending) => void = () => undefined;
    fakeEngine.method('profiles.update').mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    renderScreen(<EditProfileScreen />);
    await flush();
    fireEvent.changeText(screen.getByTestId('edit-bio'), 'Film and food.');
    // Both taps land before the engine answers with the first ticket.
    await act(async () => {
      fireEvent.press(screen.getByTestId('edit-save'));
      fireEvent.press(screen.getByTestId('edit-save'));
    });
    await act(async () => answer(pending));
    act(() => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
    await flush();
    expect(fakeEngine.method('profiles.update')).toHaveBeenCalledTimes(1);
  });

  it('asks before discarding an edit', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
    renderScreen(<EditProfileScreen />);
    await flush();
    expect(tryLeave()).toBe(false);
    fireEvent.changeText(screen.getByTestId('edit-bio'), 'Film and food.');
    expect(tryLeave()).toBe(true);
    expect(alert?.title).toBe('Discard changes?');
  });

  it('without a profile document: leaves without asking, and the first save creates it', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue({ ...PROFILE, hasProfile: false, displayName: 'jana', bio: undefined });
    fakeEngine.method('profiles.update').mockResolvedValue(ticket({ op: 'profile.update', target: { identityId: VIEWER } }));
    renderScreen(<EditProfileScreen />);
    await flush();

    expect(screen.getByTestId('edit-name')).toHaveDisplayValue('jana');
    expect(tryLeave()).toBe(false);
    expect(alert).toBeNull();
    expect(screen.getByTestId('edit-save')).toBeEnabled();
    await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
    expect(fakeEngine.method('profiles.update')).toHaveBeenCalledWith({ displayName: 'jana' });
  });

  /** The viewer's profile as the cache holds it (what the profile header shows). */
  const cachedProfile = () => queryClient.getQueryData<ProfileDTO>(queryKeys.profile.detail(VIEWER));

  it('closes an unconfirmed save as done, with the profile already showing it (QA rc7 D-1)', async () => {
    // A save whose confirmation timed out may well have landed (PRD G-3): it closed with no word
    // and the header kept the old value, so it looked as if nothing had happened.
    fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
    const pending = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
    fakeEngine.method('profiles.update').mockResolvedValue(pending);
    renderScreen(<EditProfileScreen />);
    await flush();
    fireEvent.changeText(screen.getByTestId('edit-pronouns'), 'she/her');
    fireEvent.changeText(screen.getByTestId('edit-bio'), '  ');
    await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
    expect(cachedProfile()).toMatchObject({ pronouns: 'she/her', displayName: 'Jana Abara' });
    expect(cachedProfile()).not.toHaveProperty('bio');

    act(() => fakeEngine.emit('write.status', advance(pending, { state: 'unconfirmed' })));
    expect(router.back).toHaveBeenCalled();
    expect(useToastStore.getState().current).toMatchObject({ kind: 'success', message: 'Profile updated!' });
    expect(cachedProfile()).toMatchObject({ pronouns: 'she/her' });
  });

  it('undoes the profile change when the save fails, and keeps the form', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
    const pending = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
    fakeEngine.method('profiles.update').mockResolvedValue(pending);
    renderScreen(<EditProfileScreen />);
    await flush();
    fireEvent.changeText(screen.getByTestId('edit-name'), 'Jana A.');
    await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
    expect(cachedProfile()?.displayName).toBe('Jana A.');

    act(() =>
      fakeEngine.emit(
        'write.status',
        advance(pending, {
          state: 'failed',
          retryable: true,
          error: { code: 'NETWORK', consensusCode: null, outcome: 'not-sent', retryable: true, userMessage: 'Network error.' },
        }),
      ),
    );
    expect(cachedProfile()?.displayName).toBe('Jana Abara');
    expect(useToastStore.getState().current).toMatchObject({ kind: 'error', message: "Couldn't save your profile. Try again." });
    expect(router.back).not.toHaveBeenCalled();
    expect(screen.getByTestId('edit-name')).toHaveDisplayValue('Jana A.');
  });

  it('says an earlier change is still saving, with no Retry, when the save was held back (QA rc7 D-1)', async () => {
    // lib refuses to send while an earlier change may still land: a Retry then fails the same way.
    fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
    const pending = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
    fakeEngine.method('profiles.update').mockResolvedValue(pending);
    renderScreen(<EditProfileScreen />);
    await flush();
    fireEvent.changeText(screen.getByTestId('edit-pronouns'), 'they');
    await act(async () => fireEvent.press(screen.getByTestId('edit-save')));

    act(() =>
      fakeEngine.emit(
        'write.status',
        advance(pending, {
          state: 'failed',
          retryable: true,
          error: {
            code: 'PENDING_WRITE',
            consensusCode: null,
            outcome: 'not-sent',
            retryable: true,
            userMessage: 'An earlier change from this account has not been confirmed yet, so this was not sent.',
          },
        }),
      ),
    );
    const shown = useToastStore.getState().current;
    expect(shown).toMatchObject({ kind: 'info', message: 'Your last change is still saving. Try again in a few minutes.' });
    expect(shown?.action).toBeUndefined();
    expect(cachedProfile()?.pronouns).toBeUndefined();
    expect(router.back).not.toHaveBeenCalled();
    // Nothing was sent: Save works again.
    expect(screen.getByTestId('edit-save')).toBeEnabled();
  });

  /** A check that proved a save absent (the reconciler's, 2 minutes on): retryable again. */
  const provedAbsent = (t: WriteTicket) =>
    advance(t, {
      state: 'unconfirmed',
      retryable: true,
      error: {
        code: 'NOT_RECORDED',
        consensusCode: null,
        outcome: 'not-recorded',
        retryable: true,
        userMessage: 'Checked: this write did not land.',
      },
    });

  it('keeps what a dev save did write when a check later proves the rest absent', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
    const pending = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
    fakeEngine.method('profiles.update').mockResolvedValue(pending);
    renderScreen(<EditProfileScreen />);
    await flush();
    fireEvent.changeText(screen.getByTestId('edit-bio'), 'Film and food.');
    fireEvent.changeText(screen.getByTestId('edit-pronouns'), 'she/her');
    await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
    // The DashPay profile is confirmed; the Yappr profile's wait times out.
    const halfway = advance(pending, { progress: { done: 1, total: 2 } });
    act(() => fakeEngine.emit('write.status', halfway));
    const unconfirmed = advance(halfway, { state: 'unconfirmed' });
    act(() => fakeEngine.emit('write.status', unconfirmed));
    expect(useToastStore.getState().current?.message).toBe('Profile updated!');

    act(() => fakeEngine.emit('write.status', provedAbsent(unconfirmed)));
    expect(useToastStore.getState().current).toMatchObject({ kind: 'error', message: "Couldn't save pronouns. Try again." });
    expect(useToastStore.getState().current?.action?.label).toBe('Retry');
    expect(cachedProfile()).toMatchObject({ bio: 'Film and food.' });
    expect(cachedProfile()).not.toHaveProperty('pronouns');
  });

  describe('saves that overlap (a save sent while an earlier one may still land)', () => {
    /** Every toast shown from here. */
    function toasts() {
      const shown: string[] = [];
      const stop = useToastStore.subscribe((state) => {
        if (state.current) shown.push(state.current.message);
      });
      return { shown, stop };
    }
    const refused = (code: string, outcome: 'refused' | 'not-sent') => ({
      state: 'failed' as const,
      retryable: true,
      error: { code, consensusCode: null, outcome, retryable: true, userMessage: 'No.' } as WriteTicket['error'],
    });

    /** Save 1 (pronouns) goes unconfirmed: "Profile updated!", and the form closes. */
    async function firstSaveUnconfirmed(progress?: WriteTicket['progress'], edit: [string, string][] = [['edit-pronouns', 'she/her']]) {
      fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
      const first = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
      fakeEngine.method('profiles.update').mockResolvedValueOnce(first);
      const view = renderScreen(<EditProfileScreen />);
      await flush();
      for (const [id, text] of edit) fireEvent.changeText(screen.getByTestId(id), text);
      await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
      const unconfirmed = advance(first, { state: 'unconfirmed', ...(progress ? { progress } : {}) });
      act(() => fakeEngine.emit('write.status', unconfirmed));
      view.unmount();
      return unconfirmed;
    }

    it('shows what the chain says, with one toast, when the earlier save is proved absent while the later one is sent', async () => {
      // QA rc7 review finding 2: save 2's change is applied before its ticket comes back.
      const unconfirmed = await firstSaveUnconfirmed();
      const second = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
      let answer: (t: WriteTicket) => void = () => undefined;
      fakeEngine.method('profiles.update').mockImplementationOnce(() => new Promise<WriteTicket>((resolve) => (answer = resolve)));
      renderScreen(<EditProfileScreen />);
      await flush();
      fireEvent.changeText(screen.getByTestId('edit-location'), 'Taipei');
      act(() => fireEvent.press(screen.getByTestId('edit-save')));
      const { shown, stop } = toasts();

      act(() => fakeEngine.emit('write.status', provedAbsent(unconfirmed)));
      await act(async () => answer(second));
      act(() => fakeEngine.emit('write.status', advance(second, refused('PENDING_WRITE', 'not-sent'))));
      await flush();
      stop();
      // The chain has neither save: no pronouns from save 1 come back with save 2's undo.
      expect(cachedProfile()).not.toHaveProperty('pronouns');
      expect(cachedProfile()).not.toHaveProperty('location');
      expect(cachedProfile()?.bio).toBe(PROFILE.bio);
      expect(shown).toEqual(['Your last change is still saving. Try again in a few minutes.']);
    });

    it('shows what the chain says when the later save is refused before a ticket, after the earlier one was proved absent', async () => {
      // The later save's own undo would put back the earlier save's name, which never landed.
      const unconfirmed = await firstSaveUnconfirmed(undefined, [['edit-name', 'Jana A']]);
      expect(cachedProfile()?.displayName).toBe('Jana A');
      let refuse: (error: Error) => void = () => undefined;
      fakeEngine.method('profiles.update').mockImplementationOnce(() => new Promise<WriteTicket>((_, reject) => (refuse = reject)));
      renderScreen(<EditProfileScreen />);
      await flush();
      fireEvent.changeText(screen.getByTestId('edit-name'), 'Jana B');
      act(() => fireEvent.press(screen.getByTestId('edit-save')));
      const { shown, stop } = toasts();

      act(() => fakeEngine.emit('write.status', provedAbsent(unconfirmed)));
      // The chain is read again while the later save is still being sent, which keeps its change on.
      await flush();
      expect(cachedProfile()?.displayName).toBe('Jana B');
      await act(async () => refuse(Object.assign(new Error('Display name is too long'), { code: 'BAD_REQUEST' })));
      await flush();
      stop();
      expect(cachedProfile()?.displayName).toBe(PROFILE.displayName);
      expect(shown).toEqual(["Couldn't save your profile. Try again."]);
    });

    it('keeps a save started while the chain is still being read back from rolling back to a name no save wrote', async () => {
      // Save 1 is proved absent and save 2 refused: the profile is read back from the chain. Save 3,
      // started before that read lands, must not take save 2's name (on screen, never landed) as
      // what to put back, nor leave the cancelled read undone.
      const unconfirmed = await firstSaveUnconfirmed(undefined, [['edit-name', 'Jana A']]);
      const second = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
      fakeEngine.method('profiles.update').mockResolvedValueOnce(second);
      renderScreen(<EditProfileScreen />);
      await flush();
      fireEvent.changeText(screen.getByTestId('edit-name'), 'Jana B');
      await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
      act(() => fakeEngine.emit('write.status', provedAbsent(unconfirmed)));
      await flush();

      // The chain read that save 2's refusal starts does not answer yet.
      const reads: ((profile: ProfileDTO) => void)[] = [];
      fakeEngine.method('profiles.get').mockImplementation(() => new Promise<ProfileDTO>((resolve) => reads.push(resolve)));
      act(() => fakeEngine.emit('write.status', advance(second, refused('UNKNOWN', 'refused'))));
      expect(reads.length).toBeGreaterThan(0);
      expect(cachedProfile()?.displayName).toBe('Jana B');

      fakeEngine.method('profiles.update').mockRejectedValueOnce(Object.assign(new Error('Too long'), { code: 'BAD_REQUEST' }));
      fireEvent.changeText(screen.getByTestId('edit-name'), 'Jana C');
      await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
      // The chain answers every read: neither save 1 nor save 2 nor save 3 is on it.
      fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
      await act(async () => reads.forEach((answer) => answer(PROFILE)));
      await flush();
      expect(cachedProfile()?.displayName).toBe(PROFILE.displayName);
      expect(useToastStore.getState().current?.message).toBe("Couldn't save your profile. Try again.");
    });

    it('never ends at a name no save wrote when the chain read fails, and takes the chain’s once a read succeeds', async () => {
      // A failed read repairs nothing: save 3, rejected before a ticket, must not roll back to save 2's name.
      const unconfirmed = await firstSaveUnconfirmed(undefined, [['edit-name', 'Jana A']]);
      const second = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
      fakeEngine.method('profiles.update').mockResolvedValueOnce(second);
      renderScreen(<EditProfileScreen />);
      await flush();
      fireEvent.changeText(screen.getByTestId('edit-name'), 'Jana B');
      await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
      act(() => fakeEngine.emit('write.status', provedAbsent(unconfirmed)));
      await flush();

      // Dash Platform stops answering: the chain read save 2's refusal starts fails.
      fakeEngine.method('profiles.get').mockRejectedValue(new Error('Dash Platform is unavailable'));
      act(() => fakeEngine.emit('write.status', advance(second, refused('UNKNOWN', 'refused'))));
      await flush();
      fakeEngine.method('profiles.update').mockRejectedValueOnce(Object.assign(new Error('Too long'), { code: 'BAD_REQUEST' }));
      fireEvent.changeText(screen.getByTestId('edit-name'), 'Jana C');
      await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
      await flush();
      // Not rolled back to save 2's name.
      expect(cachedProfile()?.displayName).not.toBe('Jana B');

      // A read succeeds (the app's next refetch, or the repair's own retry): the chain's name.
      fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
      await act(async () => {
        await queryClient.refetchQueries({ queryKey: queryKeys.profile.detail(VIEWER) });
      });
      await flush();
      expect(cachedProfile()?.displayName).toBe(PROFILE.displayName);
    });

    it('drops a copy no screen shows that the saves changed, so a later save never restores its never-landed name', async () => {
      // The profile read by name (a mention, a link), cached but not on screen: nothing reads it back,
      // and it came first, so a later save's undo would have taken its name as the one to restore.
      queryClient.setQueryData(queryKeys.profile.detail('jana'), PROFILE);
      const unconfirmed = await firstSaveUnconfirmed(undefined, [['edit-name', 'Jana A']]);
      expect(queryClient.getQueryData<ProfileDTO>(queryKeys.profile.detail('jana'))?.displayName).toBe('Jana A');
      const second = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
      fakeEngine.method('profiles.update').mockResolvedValueOnce(second);
      renderScreen(<EditProfileScreen />);
      await flush();
      fireEvent.changeText(screen.getByTestId('edit-name'), 'Jana B');
      await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
      act(() => fakeEngine.emit('write.status', provedAbsent(unconfirmed)));
      act(() => fakeEngine.emit('write.status', advance(second, refused('UNKNOWN', 'refused'))));
      // The profile on screen is read back from the chain, and the contest ends.
      await flush();
      expect(cachedProfile()?.displayName).toBe(PROFILE.displayName);
      expect(queryClient.getQueryData<ProfileDTO>(queryKeys.profile.detail('jana'))?.displayName).not.toBe('Jana B');

      // A later save, rejected before a ticket, puts back what it found: the chain's name.
      fakeEngine.method('profiles.update').mockRejectedValueOnce(Object.assign(new Error('Too long'), { code: 'BAD_REQUEST' }));
      fireEvent.changeText(screen.getByTestId('edit-name'), 'Jana D');
      await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
      expect(cachedProfile()?.displayName).toBe(PROFILE.displayName);
    });

    it('never puts a Retry’s change back over the chain once its attempt has failed, though its call still runs', async () => {
      // QA rc7 review 5418100307: the Retry's failure arrives before its call answers, and the chain
      // read lands in between. That read must stand, and count as the repair only because it does.
      const unconfirmed = await firstSaveUnconfirmed(undefined, [['edit-name', 'Jana A']]);
      const second = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
      fakeEngine.method('profiles.update').mockResolvedValueOnce(second);
      renderScreen(<EditProfileScreen />);
      await flush();
      fireEvent.changeText(screen.getByTestId('edit-name'), 'Jana B');
      await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
      // Save 1 may still land: the key stays contested through the Retry.
      expect(unconfirmed.state).toBe('unconfirmed');
      const failed = advance(second, refused('UNKNOWN', 'refused'));
      act(() => fakeEngine.emit('write.status', failed));
      await flush();
      expect(cachedProfile()?.displayName).toBe(PROFILE.displayName);

      // Retry: its call does not answer yet; its change goes back on at once.
      let answer: (t: WriteTicket) => void = () => undefined;
      fakeEngine.method('writes.retry').mockImplementationOnce(() => new Promise<WriteTicket>((resolve) => (answer = resolve)));
      const retry = useToastStore.getState().current?.action;
      act(() => {
        retry?.onPress();
      });
      expect(cachedProfile()?.displayName).toBe('Jana B');
      // The engine reports the attempt failed before it answers the call, and the chain is read back meanwhile.
      const failedAgain = advance(failed, refused('UNKNOWN', 'refused'));
      act(() => fakeEngine.emit('write.status', failedAgain));
      await flush();
      expect(cachedProfile()?.displayName).toBe(PROFILE.displayName);
      await act(async () => answer(failedAgain));
      await flush();
      expect(cachedProfile()?.displayName).toBe(PROFILE.displayName);

      // Save 1 proved absent now: the contest ends on a profile that is the chain's, so a later save
      // rejected before a ticket puts back the chain's name, not "Jana B".
      act(() => fakeEngine.emit('write.status', provedAbsent(unconfirmed)));
      await flush();
      fakeEngine.method('profiles.update').mockRejectedValueOnce(Object.assign(new Error('Too long'), { code: 'BAD_REQUEST' }));
      fireEvent.changeText(screen.getByTestId('edit-name'), 'Jana D');
      await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
      await flush();
      expect(cachedProfile()?.displayName).toBe(PROFILE.displayName);
    });

    it('never writes an older partial save over a newer one: the profile is the chain’s', async () => {
      // QA rc7 review finding 3: two dev saves each wrote the DashPay profile, then lost the Yappr profile.
      const half = { done: 1, total: 2 };
      const unconfirmed = await firstSaveUnconfirmed(half, [
        ['edit-bio', 'Bio one.'],
        ['edit-pronouns', 'she/her'],
      ]);
      const second = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
      fakeEngine.method('profiles.update').mockResolvedValueOnce(second);
      renderScreen(<EditProfileScreen />);
      await flush();
      fireEvent.changeText(screen.getByTestId('edit-bio'), 'Bio two.');
      fireEvent.changeText(screen.getByTestId('edit-location'), 'Taipei');
      await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
      // The chain: save 2's DashPay profile landed; neither Yappr profile did.
      fakeEngine.method('profiles.get').mockResolvedValue({ ...PROFILE, bio: 'Bio two.' });
      const { shown, stop } = toasts();

      act(() => fakeEngine.emit('write.status', advance(second, { progress: half, ...refused('UNKNOWN', 'refused') })));
      await flush();
      expect(cachedProfile()?.bio).toBe('Bio two.');
      act(() => fakeEngine.emit('write.status', provedAbsent(unconfirmed)));
      await flush();
      stop();
      expect(cachedProfile()?.bio).toBe('Bio two.');
      expect(cachedProfile()).not.toHaveProperty('pronouns');
      expect(cachedProfile()).not.toHaveProperty('location');
      expect(shown).toEqual(["Couldn't save location. Try again."]);
    });
  });

  it('takes no second Save while the first waits for the engine to take it', async () => {
    // A second Save would be queued behind the first, its name shown, and dropped if the first failed.
    fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
    const pending = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
    let answer: (t: WriteTicket) => void = () => undefined;
    fakeEngine.method('profiles.update').mockImplementationOnce(() => new Promise<WriteTicket>((resolve) => (answer = resolve)));
    renderScreen(<EditProfileScreen />);
    await flush();
    fireEvent.changeText(screen.getByTestId('edit-name'), 'Jana A');
    act(() => fireEvent.press(screen.getByTestId('edit-save')));
    expect(screen.queryByTestId('edit-save')).toBeNull();
    expect(screen.getByTestId('edit-saving')).toBeTruthy();
    expect(screen.getByTestId('edit-name')).toBeDisabled();

    // Refused before a ticket: Save comes back for another try.
    await act(async () => answer(pending));
    act(() =>
      fakeEngine.emit(
        'write.status',
        advance(pending, {
          state: 'failed',
          retryable: true,
          error: { code: 'NETWORK', consensusCode: null, outcome: 'not-sent', retryable: true, userMessage: 'Network.' },
        }),
      ),
    );
    expect(screen.getByTestId('edit-save')).toBeEnabled();
    expect(fakeEngine.method('profiles.update')).toHaveBeenCalledTimes(1);
  });

  it('ends at the chain’s name when a save queued behind another is dropped as that one fails', async () => {
    // The tracker's own guard, for any queue: two names, the first fails, the second is never sent.
    fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
    renderScreen(<EditProfileScreen />);
    await flush();
    const first = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
    let answer: (t: WriteTicket) => void = () => undefined;
    fakeEngine.method('profiles.update').mockImplementationOnce(() => new Promise<WriteTicket>((resolve) => (answer = resolve)));
    let sending: Promise<unknown> = Promise.resolve();
    act(() => {
      sending = runWrite(profileUpdateWrite, { viewerId: VIEWER, patch: { displayName: 'Jana A' } });
    });
    await act(async () => {
      await expect(runWrite(profileUpdateWrite, { viewerId: VIEWER, patch: { displayName: 'Jana B' } })).resolves.toEqual({
        status: 'queued',
      });
    });
    expect(cachedProfile()?.displayName).toBe('Jana B');
    await act(async () => {
      answer(first);
      await sending;
    });
    act(() =>
      fakeEngine.emit(
        'write.status',
        advance(first, {
          state: 'failed',
          retryable: true,
          error: { code: 'UNKNOWN', consensusCode: null, outcome: 'refused', retryable: true, userMessage: 'No.' },
        }),
      ),
    );
    await flush();
    expect(cachedProfile()?.displayName).toBe(PROFILE.displayName);
    expect(fakeEngine.method('profiles.update')).toHaveBeenCalledTimes(1);
  });

  it('puts each copy of the profile back to its own name when a save is rejected (QA rc7 review)', async () => {
    // The copy by name was read before another device renamed the profile; the screen's after.
    queryClient.setQueryData(queryKeys.profile.detail('jana'), { ...PROFILE, displayName: 'Jana A' });
    fakeEngine.method('profiles.get').mockResolvedValue({ ...PROFILE, displayName: 'Jana B' });
    fakeEngine.method('profiles.update').mockRejectedValueOnce(Object.assign(new Error('Too long'), { code: 'BAD_REQUEST' }));
    renderScreen(<EditProfileScreen />);
    await flush();
    fireEvent.changeText(screen.getByTestId('edit-name'), 'Jana C');
    await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
    expect(cachedProfile()?.displayName).toBe('Jana B');
    expect(queryClient.getQueryData<ProfileDTO>(queryKeys.profile.detail('jana'))?.displayName).toBe('Jana A');
  });

  it('blocks saving an over-long name', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
    renderScreen(<EditProfileScreen />);
    await flush();
    fireEvent.changeText(screen.getByTestId('edit-name'), 'x'.repeat(26));
    expect(screen.getByText('At most 25 characters')).toBeTruthy();
    expect(screen.getByTestId('edit-save')).toBeDisabled();
  });
});

describe('BookmarksScreen', () => {
  const saved = (id: string, content: string): PostDTO =>
    fixturePost({ id, content, viewer: { ...fixturePost().viewer!, bookmarked: true } });
  const unbookmarkTicket = (id: string) => ticket({ op: 'unbookmark', target: { id, kind: 'post', ownerId: 'x', rootPostId: null } });
  /** Issues a pending ticket, then reports it as `settle` once the call has answered, as the engine does. */
  const unbookmarkThen = (settle: Partial<WriteTicket>) => async (target: { id: string }) => {
    const issued = unbookmarkTicket(target.id);
    setTimeout(() => fakeEngine.emit('write.status', advance(issued, settle)), 0);
    return issued;
  };

  it('lists bookmarks and drops one as soon as it is removed', async () => {
    fakeEngine.method('engage.bookmarks').mockResolvedValue({
      items: [saved('b1', 'Film grain'), saved('b2', 'Salt is not optional')],
      cursor: null,
      hasMore: false,
    });
    fakeEngine.method('engage.unbookmark').mockResolvedValue(ticket({ op: 'unbookmark', target: { id: 'b1', kind: 'post', ownerId: 'x', rootPostId: null } }));
    renderScreen(<BookmarksScreen />);
    await flush();

    expect(screen.getByText('Film grain')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByTestId('bookmark-btn-b1')));
    expect(fakeEngine.method('engage.unbookmark')).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }));
    expect(screen.queryByText('Film grain')).toBeNull();
    expect(screen.getByText('Salt is not optional')).toBeTruthy();
    expect(queryClient.getQueryData(queryKeys.bookmarks)).toBeDefined();
  });

  it('clears every bookmark, one write at a time, after confirming', async () => {
    fakeEngine.method('engage.bookmarks').mockResolvedValue({
      items: [saved('b1', 'Film grain'), saved('b2', 'Salt is not optional')],
      cursor: null,
      hasMore: false,
    });
    fakeEngine.method('engage.unbookmark').mockImplementation(unbookmarkThen({ state: 'confirmed' }));
    renderScreen(<BookmarksScreen />);
    await flush();

    fireEvent(screen.getByTestId('bookmarks-menu'), 'pressAction', { nativeEvent: { event: 'clear' } });
    expect(alert?.title).toBe('Clear all bookmarks?');
    await act(async () => alert?.press('Clear all'));
    await flush();
    expect(fakeEngine.method('engage.unbookmark')).toHaveBeenCalledTimes(2);
    expect(useToastStore.getState().current?.message).toBe('All bookmarks cleared');
    expect(screen.queryByText('Film grain')).toBeNull();
  });

  it('stops clearing at the first refusal and says how far it got', async () => {
    fakeEngine.method('engage.bookmarks').mockResolvedValue({
      items: [saved('b1', 'Film grain'), saved('b2', 'Salt is not optional'), saved('b3', 'Kiln day')],
      cursor: null,
      hasMore: false,
    });
    fakeEngine
      .method('engage.unbookmark')
      .mockImplementationOnce(unbookmarkThen({ state: 'unconfirmed' }))
      .mockRejectedValue(Object.assign(new Error('Not enough credits'), { code: 'FEE_UNPAYABLE' }));
    renderScreen(<BookmarksScreen />);
    await flush();

    fireEvent(screen.getByTestId('bookmarks-menu'), 'pressAction', { nativeEvent: { event: 'clear' } });
    await act(async () => alert?.press('Clear all'));
    await flush();
    expect(fakeEngine.method('engage.unbookmark')).toHaveBeenCalledTimes(2);
    expect(useToastStore.getState().current?.message).toBe('Removed 1 of 3 bookmarks');
    expect(screen.getByText('Kiln day')).toBeTruthy();
  });

  it('waits for each removal to settle and stops at one that fails later', async () => {
    fakeEngine.method('engage.bookmarks').mockResolvedValue({
      items: [saved('b1', 'Film grain'), saved('b2', 'Salt is not optional')],
      cursor: null,
      hasMore: false,
    });
    fakeEngine.method('engage.unbookmark').mockImplementation(async (target: { id: string }) => unbookmarkTicket(target.id));
    renderScreen(<BookmarksScreen />);
    await flush();

    fireEvent(screen.getByTestId('bookmarks-menu'), 'pressAction', { nativeEvent: { event: 'clear' } });
    await act(async () => alert?.press('Clear all'));
    await flush();
    // The first removal is still pending: the second waits.
    expect(fakeEngine.method('engage.unbookmark')).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('bookmarks-clearing')).toBeTruthy();

    const issued = await fakeEngine.method('engage.unbookmark').mock.results[0]!.value;
    act(() => fakeEngine.emit('write.status', advance(issued, { state: 'failed' })));
    await flush();
    expect(fakeEngine.method('engage.unbookmark')).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().current?.message).toBe('Removed 0 of 2 bookmarks');
    expect(screen.getByText('Film grain')).toBeTruthy();
  });

  it('offers to load more when a later page fails', async () => {
    fakeEngine
      .method('engage.bookmarks')
      .mockResolvedValueOnce({ items: [saved('b1', 'Film grain')], cursor: 'c1', hasMore: true })
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ items: [saved('b2', 'Kiln day')], cursor: null, hasMore: false });
    renderScreen(<BookmarksScreen />);
    await flush();
    await act(async () => fireEvent(screen.getByTestId('bookmarks-list'), 'endReached'));
    await flush();
    // The failed page stops paging; the footer offers it again.
    expect(screen.getByText('Film grain')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByTestId('bookmarks-load-more')));
    await flush();
    expect(screen.getByText('Kiln day')).toBeTruthy();
    expect(screen.queryByTestId('bookmarks-load-more')).toBeNull();
  });

  it('removes a bookmark from the card menu, on both platforms (UX_SPEC 4.24, D-L3a-003)', async () => {
    fakeEngine.method('engage.bookmarks').mockResolvedValue({
      items: [saved('b1', 'Film grain'), saved('b2', 'Salt is not optional')],
      cursor: null,
      hasMore: false,
    });
    fakeEngine.method('engage.unbookmark').mockResolvedValue(unbookmarkTicket('b1'));
    renderScreen(<BookmarksScreen />);
    await flush();

    const menu = screen.getByTestId('more-menu-b1');
    const items = (menu.props.actions as { id: string; title: string }[]).map((item) => item.title);
    expect(items.slice(items.indexOf('Share…'), items.indexOf('Share…') + 2)).toEqual(['Share…', 'Remove bookmark']);
    await act(async () => fireEvent(menu, 'pressAction', { nativeEvent: { event: 'remove-bookmark' } }));
    expect(fakeEngine.method('engage.unbookmark')).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }));
    expect(useToastStore.getState().current?.message).toBe('Removed from bookmarks');
    expect(screen.queryByText('Film grain')).toBeNull();
    expect(screen.getByText('Salt is not optional')).toBeTruthy();
  });

  it("keeps a blocked author's bookmark as the blocked stub, never a blank list (G-6, G-7, D-L3i-003)", async () => {
    const blocked = fixturePost({
      id: 'b1',
      content: 'Film grain',
      viewer: { ...fixturePost().viewer!, bookmarked: true, authorBlocked: true },
    });
    fakeEngine.method('engage.bookmarks').mockResolvedValue({ items: [blocked], cursor: null, hasMore: false });
    renderScreen(<BookmarksScreen />);
    await flush();

    expect(screen.getByText('Post from an account you blocked')).toBeTruthy();
    expect(screen.queryByText('Film grain')).toBeNull();
    // Still removable, by its swipe action or its menu, which has nothing else.
    expect(screen.getByTestId('bookmark-remove-b1')).toBeTruthy();
    const menu = screen.getByTestId('more-menu-b1');
    expect((menu.props.actions as { title: string }[]).map((item) => item.title)).toEqual(['Remove bookmark']);
    expect(screen.getByTestId('stub-blocked').props.accessibilityActions).toEqual([{ name: 'more', label: 'More' }]);
    fakeEngine.method('engage.unbookmark').mockResolvedValue(unbookmarkTicket('b1'));
    await act(async () => fireEvent(menu, 'pressAction', { nativeEvent: { event: 'remove-bookmark' } }));
    expect(fakeEngine.method('engage.unbookmark')).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }));
  });

  it('shows the empty state', async () => {
    fakeEngine.method('engage.bookmarks').mockResolvedValue({ items: [], cursor: null, hasMore: false });
    renderScreen(<BookmarksScreen />);
    await flush();
    expect(screen.getByText('Save posts for later')).toBeTruthy();
    expect(alert).toBeNull();
  });
});
