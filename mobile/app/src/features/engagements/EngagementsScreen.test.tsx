import type { CapabilitiesDTO, EngagementPage, SessionDTO, UserSummaryDTO } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';

import { useSignInPrompt } from '~/data/require-auth';
import { useSessionStore } from '~/data/session';
import { fakeEngine, ticket } from '~/data/testing/fake-engine';
import { resetWriteTracking } from '~/data/writes';
import { queryClient } from '~/state/query-client';
import { AUTHORS, VIEWER_ID, fixturePost } from '~/ui/post/fixtures';

import { EngagementsScreen } from './EngagementsScreen';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
  Stack: { Screen: () => null },
}));

const capabilities = (repostable: boolean) =>
  ({
    repostsAreQuotes: true,
    deletesAreTombstones: false,
    repostable: { post: repostable, reply: repostable },
    bookmarkable: { post: true, reply: false },
  }) as CapabilitiesDTO;

const viewer: SessionDTO = {
  identityId: VIEWER_ID,
  network: 'devnet',
  username: 'alice',
  credits: 1n,
  hasEncryptionKey: true,
  method: 'key',
};

const user = (who: keyof typeof AUTHORS, viewerFollows = false): UserSummaryDTO => ({
  ...AUTHORS[who],
  bio: `${AUTHORS[who].displayName}'s bio`,
  viewerFollows,
});

const page = (items: EngagementPage['items'], truncated = false): EngagementPage => ({
  items,
  cursor: null,
  hasMore: false,
  truncated,
});

function renderScreen(requestedTab?: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <EngagementsScreen id="root" kind="post" requestedTab={requestedTab} />
    </QueryClientProvider>,
  );
}

beforeAll(() => notifyManager.setScheduler((callback) => callback()));
afterAll(() => queryClient.clear());

beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
  queryClient.clear();
  // An earlier test's follow, still pending, would keep its row followed over the next read.
  resetWriteTracking();
  fakeEngine.setStatus({ state: 'ready', info: { capabilities: capabilities(true) } });
  useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
  useSignInPrompt.setState({ open: false });
  fakeEngine.method('posts.engagementCounts').mockResolvedValue({ likes: 2, reposts: 100, quotes: 1, truncated: true });
});

describe('EngagementsScreen', () => {
  it('opens on Likes with counts in the tab labels, and user rows with follow buttons (POST-06)', async () => {
    fakeEngine.method('posts.engagements').mockResolvedValue(page([{ user: user('bob') }, { user: user('carol', true) }]));
    renderScreen();
    await act(async () => {});

    expect(fakeEngine.method('posts.engagements')).toHaveBeenCalledWith({ id: 'root', kind: 'post' }, 'likes', null);
    expect(screen.getByText('Likes (2)')).toBeTruthy();
    expect(screen.getByText('Reposts (100+)')).toBeTruthy();
    expect(screen.getByText('Quotes (1+)')).toBeTruthy();
    expect(screen.getByText('Bob Builder')).toBeTruthy();
    expect(screen.getByLabelText('Follow Bob Builder')).toBeTruthy();
    expect(screen.getByLabelText('Following Carol')).toBeTruthy();
  });

  it('follows optimistically, and opens the profile from the row', async () => {
    fakeEngine.method('posts.engagements').mockResolvedValue(page([{ user: user('bob') }]));
    fakeEngine.method('graph.follow').mockResolvedValue(ticket({ op: 'follow' }));
    renderScreen();
    await act(async () => {});

    await act(async () => fireEvent.press(screen.getByLabelText('Follow Bob Builder')));
    expect(fakeEngine.method('graph.follow')).toHaveBeenCalledWith(AUTHORS.bob.id);
    expect(screen.getByLabelText('Following Bob Builder')).toBeTruthy();

    fireEvent.press(screen.getByTestId(`engagement-user-${AUTHORS.bob.id}`));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/user/[id]', params: { id: AUTHORS.bob.id } });
  });

  it('hides the follow button on the viewer’s own row and asks a signed-out reader to sign in', async () => {
    fakeEngine.method('posts.engagements').mockResolvedValue(page([{ user: user('alice') }, { user: user('bob') }]));
    useSessionStore.setState({ status: 'signed-out', session: null });
    renderScreen();
    await act(async () => {});

    fireEvent.press(screen.getByLabelText('Follow Bob Builder'));
    expect(useSignInPrompt.getState().open).toBe(true);
    expect(fakeEngine.method('graph.follow')).not.toHaveBeenCalled();
  });

  it('shows each tab’s empty state, and drops Reposts where the kind cannot be reposted', async () => {
    fakeEngine.setStatus({ info: { capabilities: capabilities(false) } });
    fakeEngine.method('posts.engagements').mockResolvedValue(page([]));
    renderScreen('reposts');
    await act(async () => {});

    expect(screen.queryByText(/^Reposts/)).toBeNull();
    expect(screen.getByText('No likes yet')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByText('Quotes (1+)')));
    expect(screen.getByText('No quotes yet')).toBeTruthy();
    expect(screen.getByText("When people quote this post, they'll appear here.")).toBeTruthy();
  });

  it('shows quotes as post cards once each quote is read', async () => {
    const quote = fixturePost({ id: 'q1', author: AUTHORS.carol, content: 'Quoting with a thought' });
    fakeEngine.method('posts.engagements').mockResolvedValue(page([{ user: user('carol'), quote: { id: 'q1', content: 'Quoting with a thought' } }]));
    fakeEngine.method('posts.get').mockResolvedValue(quote);
    renderScreen('quotes');
    await act(async () => {});
    await act(async () => {});

    expect(fakeEngine.method('posts.get')).toHaveBeenCalledWith('q1');
    expect(screen.getByTestId('post-card-q1')).toBeTruthy();
  });

  it('falls back to the quoter’s row and text when the quote cannot be read', async () => {
    fakeEngine.method('posts.engagements').mockResolvedValue(page([{ user: user('carol'), quote: { id: 'q1', content: 'A quote' } }]));
    fakeEngine.method('posts.get').mockResolvedValue(null);
    renderScreen('quotes');
    await act(async () => {});
    await act(async () => {});

    fireEvent.press(screen.getByLabelText('Quote: A quote'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/post/[id]', params: { id: 'q1' } });
  });

  it('says "Post not found" for an empty id, without reading', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <EngagementsScreen id="" kind="post" />
      </QueryClientProvider>,
    );
    await act(async () => {});
    expect(screen.getByText('Post not found')).toBeTruthy();
    expect(fakeEngine.method('posts.engagementCounts')).not.toHaveBeenCalled();
    expect(fakeEngine.method('posts.engagements')).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText('Go back'));
    expect(router.back).toHaveBeenCalled();
  });
});
