import type { CapabilitiesDTO, PostDTO, SessionDTO } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { ActionSheetIOS, Alert, Share, type AlertButton } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useRemovedPosts } from '~/data/optimistic';
import { useEngineQuery } from '~/data/queries';
import { useSignInPrompt } from '~/data/require-auth';
import { useSessionStore } from '~/data/session';
import { advance, fakeEngine, ticket } from '~/data/testing/fake-engine';
import { queryClient } from '~/state/query-client';
import { keepHandlesWhole } from '~/ui/handle';
import { AUTHORS, POSTS, VIEWER_ID, fixturePost } from '~/ui/post/fixtures';
import { useToastStore } from '~/ui/toast';

import { PostItem } from './PostItem';
import { likeWrite } from './post-writes';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })) }));

const CAPABILITIES = {
  repostsAreQuotes: true,
  deletesAreTombstones: false,
  repostable: { post: true, reply: true },
  bookmarkable: { post: true, reply: false },
} as CapabilitiesDTO;

const viewer: SessionDTO = {
  identityId: VIEWER_ID,
  network: 'devnet',
  username: 'alice',
  credits: 1n,
  hasEncryptionKey: true,
  method: 'key',
};

/** Renders the post the way screens do: from the query cache, so optimistic updates show. */
function Cached({ id }: { id: string }) {
  const { data } = useEngineQuery(queryKeys.post.detail(id), (api) => api.posts.get(id), { enabled: false });
  return data ? <PostItem post={data} /> : null;
}

function renderPost(post: PostDTO) {
  queryClient.setQueryData(queryKeys.post.detail(post.id), post);
  return render(
    <QueryClientProvider client={queryClient}>
      <Cached id={post.id} />
    </QueryClientProvider>,
  );
}

const byId = (id: string) => screen.getByTestId(id);
const menuIds = (postId: string) =>
  (byId(`more-menu-${postId}`).props.actions as { id: string }[]).map((action) => action.id);
const selectMenu = (postId: string, id: string) =>
  act(() => fireEvent(byId(`more-menu-${postId}`), 'pressAction', { nativeEvent: { event: id } }));
const toastMessage = () => useToastStore.getState().current?.message;

let sheet: { options: string[]; choose: (label: string) => void } | null = null;
let alert: { title: string; message?: string; press: (text: string) => void } | null = null;

// Cache updates reach components at once (TanStack batches them on a timer otherwise).
beforeAll(() => notifyManager.setScheduler((callback) => callback()));
afterAll(() => queryClient.clear());

beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
  queryClient.clear();
  fakeEngine.setStatus({ info: { capabilities: CAPABILITIES } });
  useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
  useToastStore.setState({ current: null });
  useSignInPrompt.setState({ open: false });
  useRemovedPosts.setState({ ids: new Set() });
  sheet = null;
  alert = null;
  jest.spyOn(Alert, 'alert').mockImplementation((title, message, buttons?: AlertButton[]) => {
    alert = { title, message, press: (text) => buttons?.find((b) => b.text === text)?.onPress?.() };
  });
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((options, callback) => {
    const labels = options.options;
    sheet = { options: labels, choose: (label) => callback(labels.indexOf(label)) };
  });
});

describe('PostItem actions', () => {
  it('likes optimistically with the post as the target, and rolls back a failure', async () => {
    const post = fixturePost({ id: 'like-me' });
    const pending = ticket({ op: 'like' });
    fakeEngine.method('engage.like').mockResolvedValue(pending);
    renderPost(post);

    await act(async () => fireEvent.press(byId('like-btn-like-me')));
    expect(fakeEngine.method('engage.like')).toHaveBeenCalledWith({
      id: 'like-me',
      kind: 'post',
      ownerId: AUTHORS.bob.id,
      rootPostId: null,
    });
    expect(byId('like-btn-like-me')).toHaveAccessibleName('Unlike, 49 likes');

    act(() =>
      fakeEngine.emit(
        'write.status',
        advance(pending, {
          state: 'failed',
          error: { code: 'UNKNOWN', consensusCode: null, outcome: 'refused', retryable: false, userMessage: '' },
        }),
      ),
    );
    expect(byId('like-btn-like-me')).toHaveAccessibleName('Like, 48 likes');
    expect(toastMessage()).toBe('Failed to update like. Please try again.');
  });

  it('asks a signed-out reader to sign in instead of writing', () => {
    useSessionStore.setState({ status: 'signed-out', session: null });
    renderPost(POSTS.basic);
    fireEvent.press(byId('like-btn-post-basic'));
    fireEvent.press(byId('bookmark-btn-post-basic'));
    fireEvent.press(byId('reply-btn-post-basic'));
    expect(fakeEngine.method('engage.like')).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(useSignInPrompt.getState().open).toBe(true);
  });

  it('opens the repost sheet by slot: repost or quote, and on v10 the own quote', async () => {
    fakeEngine.method('engage.repost').mockResolvedValue(ticket({ op: 'repost' }));
    renderPost(fixturePost({ id: 'rp' }));
    fireEvent.press(byId('repost-btn-rp'));
    expect(sheet?.options).toEqual(['Repost', 'Quote', 'Cancel']);
    await act(async () => sheet?.choose('Repost'));
    expect(fakeEngine.method('engage.repost')).toHaveBeenCalledWith(expect.objectContaining({ id: 'rp' }));
    expect(toastMessage()).toBe('Reposted!');
    expect(byId('repost-btn-rp')).toBeSelected();

    const quoted = fixturePost({ id: 'qd', viewer: { ...POSTS.basic.viewer!, ownQuoteId: 'my-quote' } });
    renderPost(quoted);
    fireEvent.press(byId('repost-btn-qd'));
    expect(sheet?.options).toEqual(['Delete your quote', 'View your quote', 'Cancel']);
    act(() => sheet?.choose('View your quote'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/post/[id]', params: { id: 'my-quote' } });
  });

  it('offers a v10 own quote with text, reposted as on web, "Delete your quote" / "View your quote" (D-L3a-002)', async () => {
    const post = fixturePost({
      id: 'qw',
      stats: { likes: 0, reposts: 0, replies: 0, quotes: 1 },
      viewer: { ...POSTS.basic.viewer!, reposted: true, ownQuoteId: 'qw-quote', ownQuoteBare: false },
    });
    fakeEngine.method('posts.delete').mockResolvedValue(ticket({ op: 'post.delete' }));
    renderPost(post);
    expect(byId('repost-btn-qw')).toHaveAccessibleName('Repost or quote, 1 repost, reposted');

    fireEvent.press(byId('repost-btn-qw'));
    expect(sheet?.options).toEqual(['Delete your quote', 'View your quote', 'Cancel']);
    await act(async () => sheet?.choose('Delete your quote'));
    expect(alert?.title).toBe('Delete post?');
    await act(async () => alert?.press('Delete'));
    expect(fakeEngine.method('engage.unrepost')).not.toHaveBeenCalled();
    expect(fakeEngine.method('posts.delete')).toHaveBeenCalledWith({ id: 'qw-quote', kind: 'post', ownerId: VIEWER_ID, rootPostId: null });
    expect(toastMessage()).toBe('Quote deleted');
    // The slot is free and the quote out of the count at once, not after a refetch.
    expect(byId('repost-btn-qw')).toHaveAccessibleName('Repost or quote, 0 reposts');
    fireEvent.press(byId('repost-btn-qw'));
    expect(sheet?.options).toEqual(['Repost', 'Quote', 'Cancel']);
  });

  it('offers a v10 bare repost only "Undo repost", taking it out of the quotes it was read back in', async () => {
    const post = fixturePost({
      id: 'bare',
      stats: { likes: 0, reposts: 0, replies: 0, quotes: 2 },
      viewer: { ...POSTS.basic.viewer!, reposted: true, ownQuoteId: 'b1', ownQuoteBare: true },
    });
    fakeEngine.method('engage.unrepost').mockResolvedValue(ticket({ op: 'unrepost' }));
    renderPost(post);
    fireEvent.press(byId('repost-btn-bare'));
    expect(sheet?.options).toEqual(['Undo repost', 'Cancel']);
    await act(async () => sheet?.choose('Undo repost'));
    expect(fakeEngine.method('engage.unrepost')).toHaveBeenCalledWith(expect.objectContaining({ id: 'bare' }));
    expect(byId('repost-btn-bare')).toHaveAccessibleName('Repost or quote, 1 repost');
  });

  it('frees the v10 slot when the own quote is deleted from its own menu', async () => {
    const target = fixturePost({
      id: 'tq',
      stats: { likes: 0, reposts: 0, replies: 0, quotes: 1 },
      viewer: { ...POSTS.basic.viewer!, reposted: true, ownQuoteId: 'own-quote-post', ownQuoteBare: false },
    });
    const mine = fixturePost({ id: 'own-quote-post', author: AUTHORS.alice, quotedPostId: 'tq', quoted: target });
    fakeEngine.method('posts.delete').mockResolvedValue(ticket({ op: 'post.delete' }));
    renderPost(mine);
    selectMenu('own-quote-post', 'delete');
    await act(async () => alert?.press('Delete'));
    expect(fakeEngine.method('posts.delete')).toHaveBeenCalledWith(expect.objectContaining({ id: 'own-quote-post' }));
    expect(queryClient.getQueryData(queryKeys.post.detail('own-quote-post'))).toMatchObject({
      quoted: { stats: { quotes: 0 }, viewer: { reposted: false, ownQuoteId: null } },
    });
  });

  it('confirms deleting the own quote when undoing a repost meets QUOTE_HAS_TEXT', async () => {
    // The cache read the slot as a bare repost; the engine found text in it.
    const post = fixturePost({ id: 'qt', viewer: { ...POSTS.basic.viewer!, reposted: true, ownQuoteId: 'q1', ownQuoteBare: true } });
    fakeEngine.method('engage.unrepost').mockRejectedValue(Object.assign(new Error('text'), { code: 'QUOTE_HAS_TEXT' }));
    fakeEngine.method('posts.delete').mockResolvedValue(ticket({ op: 'post.delete' }));
    renderPost(post);

    fireEvent.press(byId('repost-btn-qt'));
    expect(sheet?.options).toEqual(['Undo repost', 'Cancel']);
    await act(async () => sheet?.choose('Undo repost'));
    expect(alert?.title).toBe('Delete post?');

    await act(async () => alert?.press('Delete'));
    expect(fakeEngine.method('posts.delete')).toHaveBeenCalledWith({
      id: 'q1',
      kind: 'post',
      ownerId: VIEWER_ID,
      rootPostId: null,
    });
    expect(toastMessage()).toBe('Quote deleted');
  });

  it('bookmarks with a toast, and hides bookmark where the contract has none', async () => {
    fakeEngine.method('engage.bookmark').mockResolvedValue(ticket({ op: 'bookmark' }));
    renderPost(fixturePost({ id: 'bm' }));
    await act(async () => fireEvent.press(byId('bookmark-btn-bm')));
    expect(byId('bookmark-btn-bm')).toBeSelected();
    expect(toastMessage()).toBe('Added to bookmarks');

    renderPost(fixturePost({ id: 'rep', kind: 'reply', rootPostId: 'root', parentId: 'root' }));
    expect(screen.queryByTestId('bookmark-btn-rep')).toBeNull();
  });

  it('opens the post, author, compose, media and the share sheet', () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    renderPost(POSTS.oneImage);
    fireEvent.press(byId('post-card-post-1img'));
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/post/[id]', params: { id: 'post-1img' } });
    fireEvent.press(byId('avatar-post-1img'));
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/user/[id]', params: { id: AUTHORS.bob.id } });
    fireEvent.press(byId('reply-btn-post-1img'));
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/compose', params: { replyTo: 'post-1img' } });
    fireEvent.press(screen.getByLabelText('Image: Sample photo 1018'));
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/media', params: { postId: 'post-1img', index: '0' } });
    fireEvent.press(byId('share-btn-post-1img'));
    expect(share).toHaveBeenCalledWith({
      url: 'https://yap.pr/devnet/post?id=post-1img',
      message: 'Bob Builder on Yappr',
    });
  });

  it('routes links in the text: mentions, tags and safe external links', () => {
    renderPost(fixturePost({ id: 'links', content: 'Hi @Carol see #Dash at https://dash.org' }));
    fireEvent.press(screen.getByText('@Carol'));
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/user/[id]', params: { id: 'carol' } });
    fireEvent.press(screen.getByText('#Dash'));
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/hashtag/[tag]', params: { tag: 'dash' } });
    fireEvent.press(screen.getByText(/^https:\/\/dash\.org/));
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://dash.org');
  });
});

describe('PostItem menu', () => {
  it("offers web's ⋯ items for someone else's post, in order", async () => {
    renderPost(POSTS.basic);
    expect(menuIds('post-basic')).toEqual(['follow', 'engagements', 'copy-link', 'share', 'block', 'report']);
    const follow = (byId('more-menu-post-basic').props.actions as { title: string }[])[0].title;
    expect(follow).toBe(keepHandlesWhole('Unfollow @bob'));
    expect(follow.replace(/\u2060/g, '')).toBe('Unfollow @bob');

    await act(async () => selectMenu('post-basic', 'copy-link'));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('https://yap.pr/devnet/post?id=post-basic');
    expect(toastMessage()).toBe('Link copied to clipboard');

    selectMenu('post-basic', 'report');
    expect(router.push).toHaveBeenLastCalledWith({
      pathname: '/report/[postId]',
      params: { postId: 'post-basic', kind: 'post' },
    });
    selectMenu('post-basic', 'block');
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/block/[userId]', params: { userId: AUTHORS.bob.id } });
    selectMenu('post-basic', 'engagements');
    expect(router.push).toHaveBeenLastCalledWith({
      pathname: '/post/[id]/engagements',
      params: { id: 'post-basic', kind: 'post' },
    });
  });

  it('unfollows the author everywhere at once', async () => {
    fakeEngine.method('graph.unfollow').mockResolvedValue(ticket({ op: 'unfollow' }));
    renderPost(POSTS.basic);
    await act(async () => selectMenu('post-basic', 'follow'));
    expect(fakeEngine.method('graph.unfollow')).toHaveBeenCalledWith(AUTHORS.bob.id);
    expect((byId('more-menu-post-basic').props.actions as { title: string }[])[0].title).toBe(keepHandlesWhole('Follow @bob'));
  });

  it('deletes the own post after the confirmation, removing it at once and restoring it on failure', async () => {
    const own = fixturePost({ id: 'mine', author: AUTHORS.alice });
    const pending = ticket({ op: 'post.delete' });
    fakeEngine.method('posts.delete').mockResolvedValue(pending);
    renderPost(own);
    expect(menuIds('mine')).toEqual(['engagements', 'copy-link', 'share', 'delete']);

    selectMenu('mine', 'delete');
    expect(alert).toMatchObject({
      title: 'Delete post?',
      message:
        'This action cannot be undone. The post will be permanently removed from the platform. Replies and quotes stay, and show that it was deleted.',
    });
    await act(async () => alert?.press('Delete'));
    expect(fakeEngine.method('posts.delete')).toHaveBeenCalledWith(expect.objectContaining({ id: 'mine', ownerId: VIEWER_ID }));
    expect(screen.queryByTestId('post-card-mine')).toBeNull();
    expect(toastMessage()).toBe('Post deleted');

    act(() =>
      fakeEngine.emit(
        'write.status',
        advance(pending, {
          state: 'failed',
          error: { code: 'NETWORK', consensusCode: null, outcome: 'not-sent', retryable: true, userMessage: 'Network error.' },
          retryable: true,
        }),
      ),
    );
    expect(byId('post-card-mine')).toBeTruthy();
    expect(useToastStore.getState().current).toMatchObject({ message: 'Network error.', action: { label: 'Retry' } });
  });
});

describe('post write specs', () => {
  it('recognise a restored ticket only for the op they asked for', () => {
    const post = POSTS.basic;
    const target = { id: post.id, kind: 'post' as const, ownerId: post.author.id, rootPostId: null };
    expect(likeWrite.matches?.(ticket({ op: 'like', target }), { post, like: true })).toBe(true);
    expect(likeWrite.matches?.(ticket({ op: 'unlike', target }), { post, like: true })).toBe(false);
    expect(likeWrite.matches?.(ticket({ op: 'like', target: { ...target, id: 'other' } }), { post, like: true })).toBe(false);
  });
});

describe('PostItem removal', () => {
  it("shows a deleted post as the deleted line with removal='stub' (threads, detail)", () => {
    useRemovedPosts.setState({ ids: new Set(['gone']) });
    queryClient.setQueryData(queryKeys.post.detail('gone'), fixturePost({ id: 'gone', author: AUTHORS.alice }));
    render(
      <QueryClientProvider client={queryClient}>
        <PostItem post={fixturePost({ id: 'gone', author: AUTHORS.alice })} removal="stub" />
        <PostItem post={fixturePost({ id: 'gone', author: AUTHORS.alice })} />
      </QueryClientProvider>,
    );
    expect(screen.getAllByTestId('post-card-gone')).toHaveLength(1);
    expect(screen.getByText('This post was deleted by its author.')).toBeTruthy();
  });
});

describe('PostItem bare reposts', () => {
  it("doesn't act on a bare repost's marks before they load", async () => {
    let answer: (stats: object) => void = () => undefined;
    fakeEngine.method('engage.stats').mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const target = fixturePost({ id: 'tgt', author: AUTHORS.carol, viewer: undefined });
    renderPost(fixturePost({ id: 'br', content: '', bareRepost: true, quoted: target, quotedPostId: 'tgt' }));
    fireEvent.press(byId('like-btn-tgt'));
    expect(fakeEngine.method('engage.like')).not.toHaveBeenCalled();
    expect(toastMessage()).toBe('Loading this post. Try again in a moment.');

    // Signed out, the sign-in sheet comes first.
    act(() => useSessionStore.setState({ status: 'signed-out', session: null }));
    fireEvent.press(byId('like-btn-tgt'));
    expect(useSignInPrompt.getState().open).toBe(true);
    await act(async () => answer({}));
  });

  it("shows the reposted post under the reposter's banner, with its own fresh counts", async () => {
    const target = fixturePost({ id: 'target', author: AUTHORS.carol, content: 'The original', viewer: undefined });
    const bare = fixturePost({
      id: 'bare',
      author: AUTHORS.bob,
      content: '',
      bareRepost: true,
      quoted: target,
      quotedPostId: 'target',
    });
    fakeEngine.method('engage.stats').mockResolvedValue({
      target: {
        stats: { likes: 7, reposts: 1, replies: 0, quotes: 0 },
        viewer: { liked: true, reposted: false, bookmarked: false, ownQuoteId: null },
      },
    });
    renderPost(bare);
    // Bare reposts in one render share a batched engage.stats call (on a 0 ms timer).
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(screen.getByText('The original')).toBeTruthy();
    expect(screen.getByTestId('repost-banner')).toHaveTextContent('Bob Builder reposted');
    expect(fakeEngine.method('engage.stats')).toHaveBeenCalledWith([{ id: 'target', kind: 'post' }]);
    expect(byId('like-btn-target')).toHaveAccessibleName('Unlike, 7 likes');
    // Whether the viewer follows the reposted author is unknown here: no follow item.
    expect(menuIds('target')).toEqual(['engagements', 'copy-link', 'share', 'block', 'report']);
  });

  it('shares a reply as its thread with the reply highlighted', async () => {
    renderPost(fixturePost({ id: 'r1', kind: 'reply', rootPostId: 'root1', parentId: 'root1' }));
    await act(async () => selectMenu('r1', 'copy-link'));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('https://yap.pr/devnet/post?id=root1&reply=r1');
  });
});
