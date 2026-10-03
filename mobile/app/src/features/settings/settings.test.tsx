import type { AccountDTO, CapabilitiesDTO, SessionDTO, SettingsDTO } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import type { ReactElement, ReactNode } from 'react';
import { Alert, BackHandler, type AlertButton } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { config } from '~/config';
import { queryKeys } from '~/data/keys';
import { useSessionStore } from '~/data/session';
import { fakeEngine } from '~/data/testing/fake-engine';
import { engineSupervisor } from '~/engine';
import { useExpiredSessions } from '~/data/session-expiry';
import { useAccounts } from '~/features/auth/accounts';
import { AccountList } from '~/features/auth/AccountSwitcher';
import { engineStateWord } from '~/features/network/NetworkChipButton';
import { useAppearance } from '~/state/appearance';
import { queryClient } from '~/state/query-client';
import { chipStateOf } from '~/ui/NetworkChip';
import { useToastStore } from '~/ui/toast';

import { AboutScreen } from './AboutScreen';
import { AccountSettingsScreen } from './AccountSettingsScreen';
import { licenses, LicensesScreen } from './LicensesScreen';
import {
  AppearanceSettingsScreen,
  FeedLanguageSettingsScreen,
  NotificationSettingsScreen,
  PrivacySettingsScreen,
} from './ContentSettingsScreens';
import { copy } from './copy';
import { SettingsScreen } from './SettingsScreen';

jest.mock('~/engine', () => {
  const fake = jest.requireActual('~/data/testing/fake-engine').engineModule;
  return {
    ...fake,
    engineStorage: { idle: jest.fn(async () => undefined) },
    engineSupervisor: { ...fake.engineSupervisor, restart: jest.fn() },
  };
});
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), navigate: jest.fn(), dismissAll: jest.fn(), canDismiss: jest.fn(() => true) },
  Stack: { Screen: () => null },
}));
// The sheet mock renders every sheet's content: a scrolling one passes it through too, and is recorded.
const mockSheetScroll = jest.fn(({ children }: { children?: ReactNode }) => children);
jest.mock('@gorhom/bottom-sheet', () => ({
  ...jest.requireActual('@gorhom/bottom-sheet/mock'),
  BottomSheetScrollView: (props: { children?: ReactNode }) => mockSheetScroll(props),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })) }));

const ALICE = '4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF';
const BOB = '8u9pqhrG1RbkuWvbqQ5WwFgaW2yGkVx2AYBnQ3j5vT1A';

const alice: SessionDTO = {
  identityId: ALICE,
  network: 'devnet',
  username: 'alice.dash',
  credits: 123_456_789_000n,
  hasEncryptionKey: true,
  method: 'key',
};

const account = (identityId: string, username: string, active: boolean): AccountDTO => ({
  identityId,
  username,
  method: 'key',
  lastUsedAt: new Date(2026, 9, 1),
  active,
});

const SETTINGS: SettingsDTO = {
  linkPreviewsEnabled: true,
  gateMediaFromNonFollowed: true,
  sendReadReceipts: true,
  sensitiveContentMode: 'blur',
  notificationSettings: {
    likes: true,
    reposts: true,
    replies: true,
    follows: true,
    mentions: true,
    messages: true,
    blogPosts: true,
  },
  payWith: 'credits',
  feedLanguage: 'en',
};

const byId = (id: string) => screen.getByTestId(id);
const toastMessage = () => useToastStore.getState().current?.message;
const cachedSettings = () => queryClient.getQueryData<SettingsDTO>(queryKeys.settings);

let alert: { title: string; message?: string; press: (text: string) => void } | null = null;

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

function renderScreen(element: ReactElement) {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>
    </SafeAreaProvider>,
  );
}

/** Lets the engine's answers (promises) land. */
const settle = () => act(async () => {});

beforeAll(() => notifyManager.setScheduler((callback) => callback()));
afterAll(() => queryClient.clear());

beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
  queryClient.clear();
  fakeEngine.setStatus({ state: 'ready', epoch: 1, info: { capabilities: { dm: 'v5' } as CapabilitiesDTO } });
  useSessionStore.setState({ status: 'signed-in', session: alice, accounts: [account(ALICE, 'alice.dash', true)] });
  useToastStore.setState({ current: null });
  useAccounts.setState({ transition: null, returnTo: null, reauth: null });
  useExpiredSessions.setState({ ids: [] });
  useAppearance.setState({ theme: 'system' });
  fakeEngine.method('settings.get').mockResolvedValue(SETTINGS);
  fakeEngine.method('profiles.get').mockResolvedValue(null);
  alert = null;
  jest.spyOn(Alert, 'alert').mockImplementation((title, message, buttons?: AlertButton[]) => {
    alert = { title, message, press: (text) => buttons?.find((b) => b.text === text)?.onPress?.() };
  });
});

describe('Settings root (SET-01)', () => {
  it('shows the account with its balance, every section, and the version line', async () => {
    renderScreen(<SettingsScreen />);
    await settle();

    expect(byId('settings-account')).toHaveAccessibleName('Account: @alice, @alice · 1.23456789 DASH');
    for (const id of ['notifications', 'privacy', 'messages', 'appearance', 'about', 'diagnostics']) {
      expect(byId(`settings-${id}`)).toBeTruthy();
    }
    expect(screen.getByText('Yappr 1.0.0 · devnet')).toBeTruthy();
    expect(byId('network-chip')).toBeTruthy();

    fireEvent.press(byId('settings-account'));
    expect(router.push).toHaveBeenCalledWith('/settings/account');
    fireEvent.press(byId('settings-messages'));
    expect(router.push).toHaveBeenCalledWith('/messages/settings');
  });

  it('the footer chip opens the network sheet: what the network means, the engine state, diagnostics (NET-07)', () => {
    const back = jest.spyOn(BackHandler, 'addEventListener');
    renderScreen(<SettingsScreen />);

    expect(byId('network-chip')).not.toBeDisabled();
    fireEvent.press(byId('network-chip'));
    expect(Alert.alert).not.toHaveBeenCalled();
    // A bottom sheet, so Android Back closes it.
    expect(back).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));
    expect(screen.getByText('Running on a Dash Platform devnet. Data may be reset.')).toBeTruthy();
    expect(byId('network-sheet-engine')).toHaveTextContent('Engine: Ready');

    act(() => fakeEngine.setStatus({ state: 'restarting' }));
    expect(byId('network-sheet-engine')).toHaveTextContent('Engine: Restarting');

    fireEvent.press(byId('network-sheet-diagnostics'));
    expect(router.push).toHaveBeenCalledWith('/settings/diagnostics');
  });

  it('every chip maps a crash as transient: booting while the supervisor restarts, unavailable when it cannot connect', () => {
    expect(chipStateOf('ready')).toBe('ready');
    expect(chipStateOf('degraded')).toBe('unavailable');
    expect(chipStateOf('crashed')).toBe('booting');
    expect(chipStateOf('restarting')).toBe('booting');
    expect(chipStateOf('failed')).toBe('unavailable');
    expect(chipStateOf('unsupported')).toBe('unavailable');
    // The sheet's engine line agrees with its chip (PRD NET-01: a degraded boot could not connect).
    expect(engineStateWord('degraded')).toBe('Unavailable');
    expect(engineStateWord('crashed')).toBe('Restarting');
  });

  it('signed out: sign-in instead of the account, content settings only', () => {
    useSessionStore.setState({ status: 'signed-out', session: null, accounts: [] });
    renderScreen(<SettingsScreen />);

    expect(screen.queryByTestId('settings-account')).toBeNull();
    expect(screen.queryByTestId('settings-notifications')).toBeNull();
    expect(screen.queryByTestId('settings-messages')).toBeNull();
    for (const id of ['privacy', 'appearance', 'about', 'diagnostics']) expect(byId(`settings-${id}`)).toBeTruthy();

    fireEvent.press(byId('settings-sign-in'));
    expect(router.push).toHaveBeenCalledWith('/sign-in');
  });

  it('signed out with accounts parked on this device: a way back to them', () => {
    useSessionStore.setState({ status: 'signed-out', session: null, accounts: [account(ALICE, 'alice.dash', false)] });
    renderScreen(<SettingsScreen />);

    expect(byId('settings-sign-in')).toBeTruthy();
    expect(byId('settings-accounts')).toHaveAccessibleName('Accounts, 1 account');
    fireEvent.press(byId('settings-accounts'));
    expect(router.push).toHaveBeenCalledWith('/settings/accounts');
  });

  it('has no Messages settings on legacy messages (v3)', () => {
    fakeEngine.setStatus({ info: { capabilities: { dm: 'legacy' } as CapabilitiesDTO } });
    renderScreen(<SettingsScreen />);
    expect(screen.queryByTestId('settings-messages')).toBeNull();
  });

  it('shows the theme it applies', () => {
    useAppearance.setState({ theme: 'dark' });
    renderScreen(<SettingsScreen />);
    expect(byId('settings-appearance')).toHaveAccessibleName('Appearance, Dark');
  });
});

describe('Privacy & Safety (SET-04, SAFE-06, SAFE-07)', () => {
  it('changes the NSFW mode at once and saves it', async () => {
    fakeEngine.method('settings.set').mockResolvedValue({ ...SETTINGS, sensitiveContentMode: 'hide' });
    renderScreen(<PrivacySettingsScreen />);
    await settle();

    expect(byId('privacy-nsfw-blur')).toBeChecked();
    await act(async () => fireEvent.press(byId('privacy-nsfw-hide')));

    expect(fakeEngine.method('settings.set')).toHaveBeenCalledWith({ sensitiveContentMode: 'hide' });
    expect(byId('privacy-nsfw-hide')).toBeChecked();
    expect(byId('privacy-nsfw-blur')).not.toBeChecked();
    expect(cachedSettings()?.sensitiveContentMode).toBe('hide');
  });

  it('refetches the loaded lists when the NSFW mode changes (the engine filters them)', async () => {
    fakeEngine.method('settings.set').mockResolvedValue({ ...SETTINGS, sensitiveContentMode: 'hide' });
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    renderScreen(<PrivacySettingsScreen />);
    await settle();

    await act(async () => fireEvent.press(byId('privacy-nsfw-hide')));

    for (const queryKey of [queryKeys.feed.all, queryKeys.explore.all, queryKeys.profile.all, queryKeys.post.all, queryKeys.bookmarks]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey });
    }
  });

  it('puts a refused change back and says so', async () => {
    fakeEngine.method('settings.set').mockRejectedValue(new Error('BAD_REQUEST'));
    renderScreen(<PrivacySettingsScreen />);
    await settle();

    await act(async () => fireEvent.press(byId('privacy-link-previews')));

    expect(fakeEngine.method('settings.set')).toHaveBeenCalledWith({ linkPreviewsEnabled: false });
    expect(byId('privacy-link-previews')).toBeChecked();
    expect(toastMessage()).toBe("Couldn't save that setting. Please try again.");
  });

  it('keeps a later change when an earlier one is refused', async () => {
    let refuse: (error: Error) => void = () => {};
    const saved = { ...SETTINGS, gateMediaFromNonFollowed: false };
    fakeEngine
      .method('settings.set')
      .mockImplementationOnce(() => new Promise((_resolve, reject) => (refuse = reject)))
      .mockImplementationOnce(async () => {
        fakeEngine.method('settings.get').mockResolvedValue(saved);
        return saved;
      });
    renderScreen(<PrivacySettingsScreen />);
    await settle();

    await act(async () => fireEvent.press(byId('privacy-link-previews')));
    await act(async () => fireEvent.press(byId('privacy-media-gate')));
    await act(async () => refuse(new Error('nope')));

    expect(cachedSettings()).toMatchObject({ linkPreviewsEnabled: true, gateMediaFromNonFollowed: false });
  });

  it('settles on the engine after two refused changes to one field', async () => {
    const refusals: ((error: Error) => void)[] = [];
    fakeEngine.method('settings.set').mockImplementation(() => new Promise((_resolve, reject) => refusals.push(reject)));
    renderScreen(<PrivacySettingsScreen />);
    await settle();

    // Off, then on again; both refused, the first last. The engine still has it on.
    await act(async () => fireEvent.press(byId('privacy-link-previews')));
    await act(async () => fireEvent.press(byId('privacy-link-previews')));
    await act(async () => refusals[1]?.(new Error('nope')));
    await act(async () => refusals[0]?.(new Error('nope')));

    expect(fakeEngine.method('settings.get')).toHaveBeenCalledTimes(2);
    expect(cachedSettings()?.linkPreviewsEnabled).toBe(true);
    expect(byId('privacy-link-previews')).toBeChecked();
  });

  it('shows and keeps a later save to a field when an earlier save to it is refused', async () => {
    let refuse: (error: Error) => void = () => {};
    let confirm: (saved: SettingsDTO) => void = () => {};
    const saved = { ...SETTINGS, sensitiveContentMode: 'show' as const };
    fakeEngine
      .method('settings.set')
      .mockImplementationOnce(() => new Promise((_resolve, reject) => (refuse = reject)))
      .mockImplementationOnce(() => new Promise((resolve) => (confirm = resolve)));
    renderScreen(<PrivacySettingsScreen />);
    await settle();

    // Blur → hide → show, the hide refused while the show is still out.
    await act(async () => fireEvent.press(byId('privacy-nsfw-hide')));
    await act(async () => fireEvent.press(byId('privacy-nsfw-show')));
    await act(async () => refuse(new Error('nope')));
    expect(cachedSettings()?.sensitiveContentMode).toBe('show');
    expect(fakeEngine.method('settings.get')).toHaveBeenCalledTimes(1);

    // The show lands: then the screen re-reads the engine, which has it.
    fakeEngine.method('settings.get').mockResolvedValue(saved);
    await act(async () => confirm(saved));
    expect(fakeEngine.method('settings.get')).toHaveBeenCalledTimes(2);
    expect(cachedSettings()?.sensitiveContentMode).toBe('show');
    expect(byId('privacy-nsfw-show')).toBeChecked();
  });

  it('keeps both of two quick changes while a fetch is cancelled', async () => {
    fakeEngine.method('settings.set').mockImplementation(async (patch: Partial<SettingsDTO>) => ({ ...SETTINGS, ...patch }));
    renderScreen(<PrivacySettingsScreen />);
    await settle();
    // A refetch in flight: each change waits for its cancel.
    fakeEngine.method('settings.get').mockImplementation(() => new Promise(() => {}));
    queryClient.invalidateQueries({ queryKey: queryKeys.settings }).catch(() => undefined);

    await act(async () => {
      fireEvent.press(byId('privacy-link-previews'));
      fireEvent.press(byId('privacy-media-gate'));
    });

    expect(cachedSettings()).toMatchObject({ linkPreviewsEnabled: false, gateMediaFromNonFollowed: false });
  });

  it('shows the media gate on, and blocked accounts and read receipts only where they apply', async () => {
    renderScreen(<PrivacySettingsScreen />);
    await settle();
    expect(byId('privacy-media-gate')).toBeChecked();
    expect(byId('privacy-blocked')).toBeTruthy();
    // DM v5 has no read receipts.
    expect(screen.queryByTestId('privacy-read-receipts')).toBeNull();

    fireEvent.press(byId('privacy-blocked'));
    expect(router.push).toHaveBeenCalledWith('/settings/blocked');
  });

  it('offers read receipts on legacy messages', async () => {
    fakeEngine.setStatus({ info: { capabilities: { dm: 'legacy' } as CapabilitiesDTO } });
    fakeEngine.method('settings.set').mockResolvedValue({ ...SETTINGS, sendReadReceipts: false });
    renderScreen(<PrivacySettingsScreen />);
    await settle();

    await act(async () => fireEvent.press(byId('privacy-read-receipts')));
    expect(fakeEngine.method('settings.set')).toHaveBeenCalledWith({ sendReadReceipts: false });
  });

  it('signed out: the content settings without blocked accounts', async () => {
    useSessionStore.setState({ status: 'signed-out', session: null, accounts: [] });
    renderScreen(<PrivacySettingsScreen />);
    await settle();
    expect(byId('privacy-nsfw')).toBeTruthy();
    expect(screen.queryByTestId('privacy-blocked')).toBeNull();
  });

  it('offers a retry when the settings cannot be read', async () => {
    fakeEngine.method('settings.get').mockRejectedValue(new Error('ENGINE_TIMEOUT'));
    // No retries with backoff here: the first failure shows.
    queryClient.setQueryDefaults(queryKeys.settings, { retry: false });
    renderScreen(<PrivacySettingsScreen />);
    await settle();
    expect(byId('settings-error')).toBeTruthy();

    fakeEngine.method('settings.get').mockResolvedValue(SETTINGS);
    await act(async () => fireEvent.press(screen.getByText('Try again')));
    expect(byId('privacy-nsfw')).toBeTruthy();
    queryClient.setQueryDefaults(queryKeys.settings, { retry: undefined });
  });
});

describe('Notifications (SET-03, NOTIF-05)', () => {
  it('turns one type off and leaves the others', async () => {
    fakeEngine.method('settings.set').mockResolvedValue({
      ...SETTINGS,
      notificationSettings: { ...SETTINGS.notificationSettings, reposts: false },
    });
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    renderScreen(<NotificationSettingsScreen />);
    await settle();

    expect(screen.getByText('In-app notifications')).toBeTruthy();
    await act(async () => fireEvent.press(byId('notification-toggle-reposts')));

    expect(fakeEngine.method('settings.set')).toHaveBeenCalledWith({ notificationSettings: { reposts: false } });
    expect(byId('notification-toggle-reposts')).not.toBeChecked();
    expect(byId('notification-toggle-likes')).toBeChecked();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.notificationsAll });
  });
});

describe('Appearance (SET-05)', () => {
  it('applies the theme at once', () => {
    renderScreen(<AppearanceSettingsScreen />);
    expect(byId('appearance-theme-system')).toBeChecked();

    fireEvent.press(byId('appearance-theme-dark'));
    expect(useAppearance.getState().theme).toBe('dark');
    expect(byId('appearance-theme-dark')).toBeChecked();
  });

  it('offers the feed language only where posts carry one (FEED-10, D-L4a-006)', async () => {
    renderScreen(<AppearanceSettingsScreen />);
    await settle();
    expect(screen.queryByTestId('appearance-feed-language')).toBeNull();

    act(() => fakeEngine.setStatus({ info: { capabilities: { dm: 'v5', postLanguage: true } as CapabilitiesDTO } }));
    expect(byId('appearance-feed-language')).toHaveTextContent(/Feed language.*English/);
    fireEvent.press(byId('appearance-feed-language'));
    expect(router.push).toHaveBeenCalledWith('/settings/feed-language');
  });

  it('saves a feed language and starts For You over in it (FEED-10, D-L4a-006)', async () => {
    fakeEngine.method('settings.set').mockResolvedValue({ ...SETTINGS, feedLanguage: 'pt' });
    const forYou = queryKeys.feed.home({ tab: 'forYou' });
    const following = queryKeys.feed.home({ tab: 'following' });
    const page = { pages: [{ items: [], cursor: null, hasMore: false }], pageParams: [null] };
    queryClient.setQueryData(forYou, page);
    queryClient.setQueryData(following, page);
    renderScreen(<FeedLanguageSettingsScreen />);
    await settle();

    expect(screen.getByText(copy.appearance.languageNote)).toBeTruthy();
    expect(byId('feed-language-en')).toBeChecked();
    await act(async () => fireEvent.press(byId('feed-language-pt')));

    expect(fakeEngine.method('settings.set')).toHaveBeenCalledWith({ feedLanguage: 'pt' });
    expect(byId('feed-language-pt')).toBeChecked();
    expect(cachedSettings()?.feedLanguage).toBe('pt');
    // For You's pages in the old language are gone; Following does not read the language.
    expect(queryClient.getQueryData(forYou)).toBeUndefined();
    expect(queryClient.getQueryData(following)).toEqual(page);
  });
});

describe('Account (SET-02, AUTH-10, AUTH-11)', () => {
  it('shows the identity, names and balance; copies the id', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue({
      id: ALICE,
      username: 'alice',
      usernames: ['alice', 'alice2'],
      displayName: 'Alice',
      avatar: {},
      hasProfile: true,
      joinedAt: new Date(2026, 2, 4),
      stats: {},
    });
    renderScreen(<AccountSettingsScreen />);
    await settle();

    expect(byId('account-identity-id')).toHaveTextContent(ALICE);
    expect(byId('account-username-alice')).toBeTruthy();
    expect(byId('account-username-alice2')).toBeTruthy();
    expect(screen.getByText('March 4, 2026')).toBeTruthy();
    expect(screen.getByText('1.23456789 DASH')).toBeTruthy();
    expect(screen.getByText('123,456,789,000 credits')).toBeTruthy();

    await act(async () => fireEvent.press(byId('account-copy-id')));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(ALICE);
    expect(toastMessage()).toBe('Identity ID copied');

    fireEvent.press(byId('account-register'));
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://yap.pr/devnet/dpns/register');
  });

  it('refreshes the balance, and says so when it cannot', async () => {
    fakeEngine.method('session.refreshBalance').mockRejectedValue(new Error('NETWORK'));
    renderScreen(<AccountSettingsScreen />);
    await settle();

    await act(async () => fireEvent.press(byId('account-refresh')));
    expect(fakeEngine.method('session.refreshBalance')).toHaveBeenCalled();
    expect(toastMessage()).toBe("Couldn't refresh the balance. Please try again.");
    expect(byId('account-refresh')).toBeTruthy();
  });

  it('signs out after the confirm, offline', async () => {
    fakeEngine.method('session.signOut').mockResolvedValue(undefined);
    fakeEngine.method('session.accounts').mockResolvedValue([]);
    renderScreen(<AccountSettingsScreen />);
    await settle();

    fireEvent.press(byId('account-sign-out'));
    expect(alert?.title).toBe('Sign out of @alice?');
    expect(alert?.message).toBe(
      'Your keys for this account are removed from this phone. Your posts and data stay on Dash Platform.',
    );
    await act(async () => alert?.press('Sign out'));

    expect(fakeEngine.method('session.signOut')).toHaveBeenCalledWith({ identityId: ALICE });
    expect(toastMessage()).toBe('Signed out');
    // After the sign-out, not before it: a fresh engine drops the page that carried the keys (SR-11).
    expect(engineSupervisor.restart).toHaveBeenCalledTimes(1);
  });

  it('cancelling the confirm keeps the account', async () => {
    renderScreen(<AccountSettingsScreen />);
    await settle();
    fireEvent.press(byId('account-sign-out'));
    await act(async () => alert?.press('Cancel'));
    expect(fakeEngine.method('session.signOut')).not.toHaveBeenCalled();
  });

  it('signing out the last account goes Home, signed out', async () => {
    fakeEngine.method('session.signOut').mockImplementation(async () => {
      useSessionStore.setState({ status: 'signed-out', session: null });
    });
    fakeEngine.method('session.accounts').mockResolvedValue([]);
    renderScreen(<AccountSettingsScreen />);
    await settle();

    fireEvent.press(byId('account-sign-out'));
    await act(async () => alert?.press('Sign out'));

    expect(router.dismissAll).toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith('/');
    expect(engineSupervisor.restart).toHaveBeenCalledTimes(1);
  });

  it('signing out the active account moves to the next one', async () => {
    const bob: SessionDTO = { ...alice, identityId: BOB, username: 'bob', credits: 0n };
    useSessionStore.setState({ accounts: [account(ALICE, 'alice.dash', true), account(BOB, 'bob', false)] });
    fakeEngine.method('session.signOut').mockImplementation(async () => {
      useSessionStore.setState({ status: 'signed-out', session: null });
    });
    fakeEngine.method('session.accounts').mockResolvedValue([account(BOB, 'bob', false)]);
    fakeEngine.method('session.switchAccount').mockResolvedValue(undefined);
    fakeEngine.method('session.current').mockResolvedValue(bob);
    jest.mocked(engineSupervisor.restart).mockImplementation(() => {
      fakeEngine.setStatus({ state: 'ready', epoch: 2 });
      useSessionStore.setState({ status: 'signed-in', session: bob });
    });
    renderScreen(<AccountSettingsScreen />);
    await settle();

    fireEvent.press(byId('account-sign-out'));
    await act(async () => alert?.press('Sign out'));

    expect(fakeEngine.method('session.signOut')).toHaveBeenCalledWith({ identityId: ALICE });
    expect(fakeEngine.method('session.switchAccount')).toHaveBeenCalledWith(BOB);
    expect(engineSupervisor.restart).toHaveBeenCalledWith('Switching accounts');
    expect(toastMessage()).toBe('Switched to @bob');
    expect(router.navigate).not.toHaveBeenCalled();
    expect(useAccounts.getState().transition).toBeNull();
  });

  describe('accounts marked "Sign in again" (AUTH-14)', () => {
    const accounts = [account(ALICE, 'alice.dash', true), account(BOB, 'bob', false)];
    const pending = () => new Promise<never>(() => undefined);

    it('marks an account whose key stopped working, and opens its sign-in from its "Sign in again"', async () => {
      useExpiredSessions.setState({ ids: [ALICE] });
      fakeEngine.method('session.prepareAddAccount').mockReturnValue(pending());
      renderScreen(<AccountList accounts={accounts} manage />);
      await settle();

      expect(byId(`account-${ALICE}-sign-in-again`)).toHaveTextContent('Sign in again');
      expect(byId(`account-${ALICE}-sign-in-again`)).toHaveAccessibleName('Sign in again: @alice');
      expect(byId(`account-${ALICE}`)).toHaveAccessibleName(/, Sign in again$/);
      expect(screen.queryByTestId(`account-${BOB}-sign-in-again`)).toBeNull();
      await act(async () => fireEvent.press(byId(`account-${ALICE}-sign-in-again`)));
      expect(fakeEngine.method('session.prepareAddAccount')).toHaveBeenCalledTimes(1);
      expect(useAccounts.getState().transition?.label).toBe('Getting ready to sign in again…');
      expect(fakeEngine.method('session.switchAccount')).not.toHaveBeenCalled();
    });

    it('opens the sign-in of the current account on tap: there is nothing to switch to', async () => {
      useExpiredSessions.setState({ ids: [ALICE] });
      fakeEngine.method('session.prepareAddAccount').mockReturnValue(pending());
      renderScreen(<AccountList accounts={accounts} manage />);
      await settle();

      await act(async () => fireEvent.press(byId(`account-${ALICE}`)));
      expect(fakeEngine.method('session.prepareAddAccount')).toHaveBeenCalledTimes(1);
    });

    it('switches to a marked account on tap, for reading: reads keep working', async () => {
      useExpiredSessions.setState({ ids: [BOB] });
      fakeEngine.method('session.switchAccount').mockReturnValue(pending());
      renderScreen(<AccountList accounts={accounts} manage />);
      await settle();

      await act(async () => fireEvent.press(byId(`account-${BOB}`)));
      expect(fakeEngine.method('session.switchAccount')).toHaveBeenCalledWith(BOB);
      expect(useAccounts.getState().transition?.label).toBe('Switching to @bob…');
      expect(fakeEngine.method('session.prepareAddAccount')).not.toHaveBeenCalled();
    });

    it('opens the sign-in of a marked account whose key is gone, coming back here if abandoned', async () => {
      useExpiredSessions.setState({ ids: [BOB] });
      fakeEngine.method('session.switchAccount').mockResolvedValue(undefined);
      // The engine switched, but the restored boot has no key for the account: nobody is signed in.
      fakeEngine.method('session.current').mockResolvedValue(null);
      jest.mocked(engineSupervisor.restart).mockImplementation(() => {
        fakeEngine.setStatus({ state: 'ready', epoch: 2 });
        useSessionStore.setState({ status: 'signed-out', session: null });
      });
      renderScreen(<AccountList accounts={accounts} manage />);
      await settle();

      await act(async () => fireEvent.press(byId(`account-${BOB}`)));
      await settle();
      expect(router.push).toHaveBeenCalledWith('/sign-in');
      expect(useAccounts.getState()).toMatchObject({ reauth: BOB, returnTo: ALICE, transition: null });
      // What happens next is the sign-in, not "Couldn't switch accounts".
      expect(toastMessage()).toBeUndefined();
    });

    it('opens the sign-in of a marked account the engine would not switch to', async () => {
      useExpiredSessions.setState({ ids: [BOB] });
      fakeEngine.method('session.switchAccount').mockRejectedValue(Object.assign(new Error('nope'), { code: 'BAD_REQUEST' }));
      fakeEngine.method('session.prepareAddAccount').mockReturnValue(pending());
      renderScreen(<AccountList accounts={accounts} manage />);
      await settle();

      await act(async () => fireEvent.press(byId(`account-${BOB}`)));
      await settle();
      expect(fakeEngine.method('session.prepareAddAccount')).toHaveBeenCalledTimes(1);
      expect(useAccounts.getState().transition?.label).toBe('Getting ready to sign in again…');
    });
  });

  it('links to the accounts on this device, and to app lock', async () => {
    useSessionStore.setState({ accounts: [account(ALICE, 'alice.dash', true), account(BOB, 'bob', false)] });
    renderScreen(<AccountSettingsScreen />);
    await settle();

    expect(byId('account-accounts')).toHaveAccessibleName('Accounts, 2 accounts');
    fireEvent.press(byId('account-accounts'));
    expect(router.push).toHaveBeenCalledWith('/settings/accounts');
    fireEvent.press(byId('account-app-lock'));
    expect(router.push).toHaveBeenCalledWith('/settings/app-lock');
  });

  it('signed out with accounts parked on this device: the way back to them', () => {
    useSessionStore.setState({ status: 'signed-out', session: null, accounts: [account(ALICE, 'alice.dash', false)] });
    renderScreen(<AccountSettingsScreen />);

    expect(byId('account-signed-out-accounts')).toBeTruthy();
    fireEvent.press(byId('account-accounts'));
    expect(router.push).toHaveBeenCalledWith('/settings/accounts');
  });

  it('signed out: a way to sign in', () => {
    useSessionStore.setState({ status: 'signed-out', session: null, accounts: [] });
    renderScreen(<AccountSettingsScreen />);
    expect(byId('account-signed-out')).toBeTruthy();
  });
});

describe('About (SET-06, SET-07)', () => {
  it('shows the version and network, opens the legal pages, and the bundled rules', () => {
    renderScreen(<AboutScreen />);

    expect(byId('about-version')).toHaveAccessibleName('Version, 1.0.0');
    expect(byId('about-network')).toHaveAccessibleName('Network, devnet');
    // Baked in at build time (app.config.ts), never fetched.
    expect(config.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(byId('about-commit')).toHaveAccessibleName(`Commit, ${config.commit!.slice(0, 8)}`);

    fireEvent.press(byId('about-terms'));
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://yap.pr/terms');
    fireEvent.press(byId('about-privacy'));
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://yap.pr/privacy');

    expect(byId('about-rules')).toHaveAccessibleName('Community rules summary');
    fireEvent.press(byId('about-rules'));
    expect(screen.getByText('What you post is public and permanent on Dash Platform.')).toBeTruthy();
    // A scrolling sheet, so large text still reaches every rule.
    expect(mockSheetScroll).toHaveBeenCalledWith(expect.objectContaining({ testID: 'about-rules-sheet' }));
  });

  it('has Community rules apart from the summary: the full rules the terms gate shows', () => {
    renderScreen(<AboutScreen />);

    expect(byId('about-community-rules')).toHaveAccessibleName('Community rules');
    fireEvent.press(byId('about-community-rules'));
    expect(mockSheetScroll).toHaveBeenCalledWith(expect.objectContaining({ testID: 'about-community-rules-sheet' }));
    expect(screen.getByText('Zero tolerance for abuse')).toBeTruthy();
  });

  it('opens the native open-source licenses list, not a web page', () => {
    renderScreen(<AboutScreen />);

    fireEvent.press(byId('about-licenses'));
    expect(router.push).toHaveBeenCalledWith('/settings/licenses');
    expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
  });

  it('lists every shipped package with its license, and opens one to its license text', () => {
    renderScreen(<LicensesScreen />);

    expect(licenses.packages.length).toBeGreaterThan(500);
    const pkg = licenses.packages.slice(0, 10).find((item) => item.texts.length > 0)!;
    const id = `${pkg.name}@${pkg.version}`;
    expect(byId(`license-${id}`)).toHaveAccessibleName(`${pkg.name} ${pkg.version}, ${pkg.license}`);
    expect(screen.queryByTestId(`license-text-${id}`)).toBeNull();
    fireEvent.press(byId(`license-${id}`));
    expect(byId(`license-text-${id}`)).toHaveTextContent(licenses.texts[pkg.texts[0]].slice(0, 40), { exact: false });
  });
});
