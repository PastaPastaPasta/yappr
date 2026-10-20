import type { CapabilitiesDTO, PostDTO, PrivateFeedOverviewDTO, SessionDTO, UserSummaryDTO } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { ReactElement, ReactNode } from 'react';
import { Alert, type AlertButton } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useSessionStore } from '~/data/session';
import { advance, fakeEngine, ticket } from '~/data/testing/fake-engine';
import { destinationOf } from '~/features/notifications/notification-model';
import { PostItem } from '~/features/post/PostItem';
import { resolveLink } from '~/navigation/deep-links';
import { queryClient } from '~/state/query-client';
import { AUTHORS, POSTS, VIEWER_ID, fixturePost } from '~/ui/post/fixtures';
import { useToastStore } from '~/ui/toast';

import { PrivateFeedAccessButton } from './PrivateFeedAccessButton';
import { PrivateFeedScreen } from './PrivateFeedScreen';
import { splitImage, teaserOf } from './PrivatePostBody';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('expo-router', () => ({ router: { push: jest.fn() }, Stack: { Screen: () => null } }));

const CAPABILITIES = {
  privateFeeds: true,
  repostsAreQuotes: true,
  repostable: { post: true, reply: true },
  bookmarkable: { post: true, reply: true },
} as CapabilitiesDTO;

const viewer: SessionDTO = {
  identityId: VIEWER_ID,
  network: 'devnet',
  username: 'alice',
  credits: 1n,
  hasEncryptionKey: true,
  method: 'app-connect' as SessionDTO['method'],
};

const OWNER = AUTHORS.carol.id;
/** Owners of their own for the profile tests: the tracker queues a write behind one still pending for the same owner. */
const ASKED = 'AskedAskedAskedAskedAskedAskedAskedAskedAsk1';
const MEMBER = 'MemberMemberMemberMemberMemberMemberMember1';
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const person = (id: string, name: string): UserSummaryDTO => ({
  id,
  username: name,
  displayName: name,
  avatar: { uri: null, dicebear: { style: 'identicon', seed: id } },
  resolved: true,
});

/** As screens render: from the query client, inside the safe area the sheets read. */
function Providers({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </SafeAreaProvider>
  );
}

function renderIn(ui: ReactElement) {
  return render(ui, { wrapper: Providers });
}

let alert: { title: string; press: (text: string) => void } | null = null;

// A post card's first render pulls in the whole post UI: on a busy machine that takes longer than RNTL's 1 s.
configure({ asyncUtilTimeout: 10_000 });
beforeAll(() => notifyManager.setScheduler((callback) => callback()));
afterAll(() => queryClient.clear());

beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
  queryClient.clear();
  fakeEngine.setStatus({ state: 'ready', info: { capabilities: CAPABILITIES } });
  useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
  useToastStore.setState({ current: null });
  alert = null;
  jest.spyOn(Alert, 'alert').mockImplementation((title, _message, buttons?: AlertButton[]) => {
    alert = { title, press: (text) => buttons?.find((b) => b.text === text)?.onPress?.() };
  });
});

describe('a private post in a feed', () => {
  const post: PostDTO = { ...POSTS.private, author: AUTHORS.carol };

  it('shows the decrypted text in the private card, and offers Reply', async () => {
    fakeEngine
      .method('privateFeed.read')
      .mockResolvedValue({ state: 'open', text: 'for my followers', feedOwnerId: OWNER, own: false, followerCount: null });
    renderIn(<PostItem post={post} />);
    expect(await screen.findByText('for my followers')).toBeTruthy();
    expect(screen.queryByText('Only approved followers can see this.')).toBeNull();
    expect(screen.getByTestId(`reply-btn-${post.id}`)).toBeTruthy();
    expect(fakeEngine.method('privateFeed.read')).toHaveBeenCalledWith(post.id);
  });

  it('asks a viewer who has not asked to request access, and sends the request natively', async () => {
    fakeEngine.method('privateFeed.read').mockResolvedValue({ state: 'locked', reason: 'none', feedOwnerId: OWNER, own: false, messagingKey: 'ready' });
    const sent = ticket({ op: 'privateFeed.request', target: { identityId: OWNER } });
    fakeEngine.method('privateFeed.request').mockResolvedValue(sent);
    renderIn(<PostItem post={post} />);
    fireEvent.press(await screen.findByTestId('private-request-access'));
    await waitFor(() => expect(fakeEngine.method('privateFeed.request')).toHaveBeenCalledWith(OWNER));
    expect(screen.queryByText('Open on yap.pr')).toBeNull();
    expect(screen.queryByTestId(`reply-btn-${post.id}`)).toBeNull();
    // Confirmed: the post and the access state are read again.
    fakeEngine.method('privateFeed.read').mockResolvedValue({ state: 'locked', reason: 'pending', feedOwnerId: OWNER, own: false, messagingKey: 'ready' });
    act(() => fakeEngine.emit('write.status', advance(sent, { state: 'confirmed' })));
    expect(await screen.findByTestId('private-pending')).toBeTruthy();
  });

  it('opens in the locked card’s shape, and a list may leave out what the viewer can’t read', async () => {
    let answer: (value: unknown) => void = () => undefined;
    fakeEngine.method('privateFeed.read').mockReturnValue(new Promise((resolve) => (answer = resolve)) as never);
    renderIn(<PostItem post={post} hideUnreadablePrivate />);
    // Loading is no answer: the card shows, shaped like the locked panel.
    expect(screen.getByTestId('private-post-loading')).toHaveTextContent('Private post', { exact: false });
    await act(async () => answer({ state: 'locked', reason: 'none', feedOwnerId: OWNER, own: false, messagingKey: 'ready' }));
    expect(screen.queryByTestId(`post-card-${post.id}`)).toBeNull();
  });

  it("never leaves out the viewer's own reply, nor a post they're approved for but can't open here", async () => {
    const mine = fixturePost({ id: 'my-private-reply', encrypted: true, content: '', author: { ...AUTHORS.alice, id: VIEWER_ID } });
    fakeEngine.method('privateFeed.read').mockResolvedValue({ state: 'locked', reason: 'none', feedOwnerId: OWNER, own: false, messagingKey: 'ready' });
    renderIn(<PostItem post={mine} hideUnreadablePrivate />);
    expect(await screen.findByTestId('private-request-access')).toBeTruthy();
    screen.unmount();
    queryClient.clear();
    fakeEngine.method('privateFeed.read').mockResolvedValue({ state: 'locked', reason: 'needs-key', feedOwnerId: OWNER, own: false, messagingKey: 'allow-in-wallet' });
    renderIn(<PostItem post={post} hideUnreadablePrivate />);
    expect(await screen.findByTestId('private-renew-wallet')).toBeTruthy();
    expect(screen.getByTestId(`post-card-${post.id}`).props.accessibilityActions).toContainEqual({ name: 'private', label: 'Renew in your wallet' });
  });

  it("offers the locked card's button to a screen reader, as an action of the card", async () => {
    fakeEngine.method('privateFeed.read').mockResolvedValue({ state: 'locked', reason: 'none', feedOwnerId: OWNER, own: false, messagingKey: 'ready' });
    const sent = ticket({ op: 'privateFeed.request', target: { identityId: OWNER } });
    fakeEngine.method('privateFeed.request').mockResolvedValue(sent);
    renderIn(<PostItem post={post} />);
    await screen.findByTestId('private-request-access');
    const card = screen.getByTestId(`post-card-${post.id}`);
    expect(card.props.accessibilityActions).toContainEqual({ name: 'private', label: 'Request access' });
    fireEvent(card, 'accessibilityAction', { nativeEvent: { actionName: 'private' } });
    await waitFor(() => expect(fakeEngine.method('privateFeed.request')).toHaveBeenCalledWith(OWNER));
    // Settled, so no request is left on its way for the next test.
    act(() => fakeEngine.emit('write.status', advance(sent, { state: 'confirmed' })));
  });

  it('cancels a pending request after a confirmation', async () => {
    fakeEngine.method('privateFeed.read').mockResolvedValue({ state: 'locked', reason: 'pending', feedOwnerId: OWNER, own: false, messagingKey: 'ready' });
    fakeEngine.method('privateFeed.leave').mockResolvedValue(ticket({ op: 'privateFeed.leave', target: { identityId: OWNER } }));
    renderIn(<PostItem post={post} />);
    fireEvent.press(await screen.findByTestId('private-cancel-request'));
    expect(alert?.title).toBe('Cancel your request?');
    act(() => alert?.press('Cancel request'));
    await waitFor(() => expect(fakeEngine.method('privateFeed.leave')).toHaveBeenCalledWith(OWNER));
  });

  it('sends a wallet session without the messaging key to renew in the wallet', async () => {
    fakeEngine
      .method('privateFeed.read')
      .mockResolvedValue({ state: 'locked', reason: 'needs-key', feedOwnerId: OWNER, own: false, messagingKey: 'allow-in-wallet' });
    renderIn(<PostItem post={post} />);
    fireEvent.press(await screen.findByTestId('private-renew-wallet'));
    expect(router.push).toHaveBeenCalledWith('/sign-in/renew');
  });

  it('says a removed follower was removed, and lets them ask again', async () => {
    fakeEngine.method('privateFeed.read').mockResolvedValue({ state: 'locked', reason: 'revoked', feedOwnerId: OWNER, own: false, messagingKey: 'ready' });
    renderIn(<PostItem post={post} />);
    expect(await screen.findByText('Your access to this private feed was removed.')).toBeTruthy();
    expect(screen.getByText('Ask again')).toBeTruthy();
  });

  it('keeps the public teaser, and shows an encrypted image link as the image', () => {
    expect(teaserOf(fixturePost({ content: '🔒' }))).toBeNull();
    expect(teaserOf(fixturePost({ content: ' a peek ' }))).toBe('a peek');
    expect(splitImage('look\n\nhttps://img.example/a.png')).toEqual({ text: 'look', image: 'https://img.example/a.png' });
    expect(splitImage('no image here')).toEqual({ text: 'no image here', image: null });
  });
});

describe('the profile control', () => {
  it('requests access to someone the viewer follows; shows nothing for someone they do not', async () => {
    fakeEngine.method('privateFeed.access').mockResolvedValue({ hasFeed: true, status: 'none', messagingKey: 'ready' });
    fakeEngine.method('privateFeed.request').mockResolvedValue(ticket({ op: 'privateFeed.request', target: { identityId: ASKED } }));
    const { rerender } = renderIn(<PrivateFeedAccessButton ownerId={ASKED} following={false} name="Carol" />);
    expect(screen.queryByTestId('profile-private-access')).toBeNull();
    rerender(<PrivateFeedAccessButton ownerId={ASKED} following name="Carol" />);
    fireEvent.press(await screen.findByTestId('profile-private-request'));
    await waitFor(() => expect(fakeEngine.method('privateFeed.request')).toHaveBeenCalledWith(ASKED));
  });

  it('lets an approved follower leave', async () => {
    fakeEngine.method('privateFeed.access').mockResolvedValue({ hasFeed: true, status: 'approved', messagingKey: 'ready' });
    fakeEngine.method('privateFeed.leave').mockResolvedValue(ticket({ op: 'privateFeed.leave', target: { identityId: MEMBER } }));
    renderIn(<PrivateFeedAccessButton ownerId={MEMBER} following name="Carol" />);
    fireEvent.press(await screen.findByTestId('profile-private-approved'));
    act(() => alert?.press('Leave private feed'));
    await waitFor(() => expect(fakeEngine.method('privateFeed.leave')).toHaveBeenCalledWith(MEMBER));
  });
});

describe('Settings → Private feed', () => {
  const ON: PrivateFeedOverviewDTO = {
    enabled: true,
    messagingKey: 'ready',
    since: new Date(2026, 9, 1),
    followers: 1,
    capacity: 4096,
    removals: 0,
    maxRemovals: 4094,
    keyRotated: false,
    nearlyFull: false,
    move: null,
  };

  it('turns the feed on with the wallet key, and explains how it works', async () => {
    fakeEngine.method('privateFeed.overview').mockResolvedValue({ enabled: false, messagingKey: 'ready', capacity: 4096 });
    const sent = ticket({ op: 'privateFeed.enable' });
    fakeEngine.method('privateFeed.enable').mockResolvedValue(sent);
    renderIn(<PrivateFeedScreen />);
    expect(await screen.findByText('Moderators can read a private post if someone reports it')).toBeTruthy();
    // No implementation detail on the way in: no capacity, keys or encryption talk.
    expect(screen.queryByText(/4,096|encrypt|messaging key/)).toBeNull();
    fireEvent.press(screen.getByTestId('private-enable'));
    await waitFor(() => expect(fakeEngine.method('privateFeed.enable')).toHaveBeenCalled());
    // Its key is the owner's: settled, so the tests after it start with none on its way.
    act(() => fakeEngine.emit('write.status', advance(sent, { state: 'confirmed' })));
  });

  it("can't turn on without the messaging key, and says how to get it", async () => {
    fakeEngine.method('privateFeed.overview').mockResolvedValue({ enabled: false, messagingKey: 'allow-in-wallet', capacity: 4096 });
    renderIn(<PrivateFeedScreen />);
    expect(await screen.findByTestId('private-renew-wallet')).toBeTruthy();
    expect(screen.getByTestId('private-enable').props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('approves a request, sets one aside, and removes a follower after a confirmation', async () => {
    const bob = person(AUTHORS.bob.id, 'bob');
    const dave = person('DaveDaveDaveDaveDaveDaveDaveDaveDaveDaveDave1', 'dave');
    const erin = person('ErinErinErinErinErinErinErinErinErinErinErin1', 'erin');
    fakeEngine.method('privateFeed.overview').mockResolvedValue(ON);
    fakeEngine.method('privateFeed.requests').mockResolvedValue([
      { user: bob, requestedAt: new Date(), renewal: false },
      { user: erin, requestedAt: new Date(), renewal: false },
    ]);
    fakeEngine.method('privateFeed.followers').mockResolvedValue([{ user: dave, grantedAt: new Date() }]);
    fakeEngine.method('privateFeed.approve').mockResolvedValue(ticket({ op: 'privateFeed.approve', target: { identityId: bob.id } }));
    fakeEngine.method('privateFeed.revoke').mockResolvedValue(ticket({ op: 'privateFeed.revoke', target: { identityId: dave.id } }));
    renderIn(<PrivateFeedScreen />);

    fireEvent.press(await screen.findByTestId(`private-approve-${bob.id}`));
    await waitFor(() => expect(fakeEngine.method('privateFeed.approve')).toHaveBeenCalledWith(bob.id));

    fireEvent.press(screen.getByTestId(`private-ignore-${erin.id}`));
    expect(screen.queryByTestId(`private-request-${erin.id}`)).toBeNull();

    fireEvent.press(screen.getByTestId(`private-remove-${dave.id}`));
    expect(alert?.title).toBe('Remove @dave?');
    act(() => alert?.press('Remove'));
    await waitFor(() => expect(fakeEngine.method('privateFeed.revoke')).toHaveBeenCalledWith(dave.id));
  });

  it('reads the follower list once more after an approval, for a node that had not caught up', async () => {
    const frank = person('FrankFrankFrankFrankFrankFrankFrankFrankFran1', 'frank');
    fakeEngine.method('privateFeed.overview').mockResolvedValue(ON);
    fakeEngine.method('privateFeed.requests').mockResolvedValue([{ user: frank, requestedAt: new Date(), renewal: false }]);
    fakeEngine.method('privateFeed.followers').mockResolvedValue([]);
    const sent = ticket({ op: 'privateFeed.approve', target: { identityId: frank.id } });
    fakeEngine.method('privateFeed.approve').mockResolvedValue(sent);
    renderIn(<PrivateFeedScreen />);
    fireEvent.press(await screen.findByTestId(`private-approve-${frank.id}`));
    await waitFor(() => expect(fakeEngine.method('privateFeed.approve')).toHaveBeenCalled());
    jest.useFakeTimers();
    // Confirmed, but the first read after it still misses the new follower.
    fakeEngine.method('privateFeed.requests').mockResolvedValue([]);
    act(() => fakeEngine.emit('write.status', advance(sent, { state: 'confirmed' })));
    await act(async () => {});
    expect(screen.queryByTestId(`private-remove-${frank.id}`)).toBeNull();
    fakeEngine.method('privateFeed.followers').mockResolvedValue([{ user: frank, grantedAt: new Date() }]);
    await act(async () => {
      jest.advanceTimersByTime(4_000);
    });
    jest.useRealTimers();
    expect(await screen.findByTestId(`private-remove-${frank.id}`)).toBeTruthy();
  });

  it('shows a paused follower move with Continue', async () => {
    fakeEngine.method('privateFeed.overview').mockResolvedValue({ ...ON, move: { done: 1, total: 3, error: 'The move paused.' } });
    fakeEngine.method('privateFeed.requests').mockResolvedValue([]);
    fakeEngine.method('privateFeed.followers').mockResolvedValue([]);
    fakeEngine.method('privateFeed.continueMove').mockResolvedValue(ticket({ op: 'privateFeed.move' }));
    renderIn(<PrivateFeedScreen />);
    expect(await screen.findByText('Moving followers: 1 of 3')).toBeTruthy();
    fireEvent.press(screen.getByTestId('private-continue-move'));
    await waitFor(() => expect(fakeEngine.method('privateFeed.continueMove')).toHaveBeenCalled());
  });
});

describe('links into the private feed', () => {
  it("opens an access request notification on the owner's private feed settings", () => {
    const row = { type: 'privateFeedRequest', actors: [AUTHORS.bob], unreadIds: [] } as unknown as Parameters<typeof destinationOf>[0];
    expect(destinationOf(row)).toEqual({ kind: 'privateFeedRequests' });
  });

  it("maps web's settings?section=privateFeed to the native screen", () => {
    const options = { viewerId: VIEWER_ID, initial: false, webBasePath: '', allowAppRoutes: false };
    expect(resolveLink('https://yap.pr/settings?section=privateFeed', options)).toMatchObject({
      kind: 'route',
      route: '/settings/private-feed',
    });
  });
});
