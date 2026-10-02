import type { CapabilitiesDTO, SessionDTO, UserSummaryDTO } from '@engine/api';
import { useNetInfo } from '@react-native-community/netinfo';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ActionSheetIOS } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { queryKeys } from '~/data/keys';
import { useSessionStore } from '~/data/session';
import { fakeEngine, ticket } from '~/data/testing/fake-engine';
import { queryClient } from '~/state/query-client';
import { AUTHORS, VIEWER_ID, fixturePost } from '~/ui/post/fixtures';

import { ComposeScreen } from './ComposeScreen';
import { deleteDraft, loadDraft, saveDraft, type ComposeContext } from './drafts';
import { usePendingPosts } from './pending-posts';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
const mockNavigation = { addListener: jest.fn(() => () => undefined), dispatch: jest.fn() };
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({})),
  useNavigation: () => mockNavigation,
}));
// The close guard: the latest callback the screen registered, as the native stack calls it on a swipe.
let mockPreventRemove: ((options: { data: { action: { type: string } } }) => void) | null = null;
jest.mock('expo-router/react-navigation', () => ({
  usePreventRemove: (prevent: boolean, callback: typeof mockPreventRemove) => {
    mockPreventRemove = prevent ? callback : null;
  },
}));
jest.mock('@react-native-community/netinfo', () => ({
  ...jest.requireActual('@react-native-community/netinfo/jest/netinfo-mock.js'),
  useNetInfo: jest.fn(() => ({ isConnected: true })),
}));

const viewer: SessionDTO = {
  identityId: VIEWER_ID,
  network: 'devnet',
  username: 'alice',
  credits: 1n,
  hasEncryptionKey: true,
  method: 'key',
};
const POST: ComposeContext = { mode: 'post', targetId: null };
const CAPABILITIES = { contentLimits: { chars: 20, bytes: 40 }, hashtagsInline: true } as CapabilitiesDTO;

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

const byId = (id: string) => screen.getByTestId(id);
const postButton = () => byId('compose-post');
const type = (text: string, index = 0) => fireEvent.changeText(byId(`compose-input-${index}`), text);

/** Renders compose and lets its reads (the viewer's profile, the target) settle. */
async function renderCompose() {
  render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={queryClient}>
        <ComposeScreen />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
  await act(async () => {});
}

let sheet: { options: string[]; choose: (label: string) => void } | null = null;

beforeAll(() => notifyManager.setScheduler((callback) => callback()));
afterAll(() => queryClient.clear());

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  fakeEngine.reset();
  queryClient.clear();
  usePendingPosts.setState({ entries: {} });
  deleteDraft(VIEWER_ID, POST);
  fakeEngine.setStatus({ state: 'ready', info: { capabilities: CAPABILITIES } });
  useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
  fakeEngine.method('profiles.get').mockResolvedValue(null);
  jest.mocked(useLocalSearchParams).mockReturnValue({});
  jest.mocked(useNetInfo).mockReturnValue({ isConnected: true } as ReturnType<typeof useNetInfo>);
  sheet = null;
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((options, callback) => {
    const labels = options.options;
    sheet = { options: labels, choose: (label) => callback(labels.indexOf(label)) };
  });
});

it('asks a signed-out user to sign in', async () => {
  useSessionStore.setState({ status: 'signed-out', session: null });
  await renderCompose();
  expect(screen.getByText('Sign in to post')).toBeTruthy();
  fireEvent.press(screen.getByText('Sign in'));
  expect(router.replace).toHaveBeenCalledWith('/sign-in');
});

it('enables Post once there is visible text, and posts: the sheet closes', async () => {
  fakeEngine.method('posts.publish').mockResolvedValue(ticket({ op: 'post.publish' }));
  await renderCompose();
  expect(postButton()).toBeDisabled();

  type('​  ');
  expect(postButton()).toBeDisabled();

  type('Hello #dash');
  expect(postButton()).toBeEnabled();
  expect(byId('compose-counter')).toHaveAccessibleName('11 of 20 characters');

  await act(async () => fireEvent.press(postButton()));
  expect(fakeEngine.method('posts.publish')).toHaveBeenCalledWith(
    expect.objectContaining({ parts: [{ text: 'Hello #dash' }], sensitive: false, mediaUrl: null }),
  );
  expect(router.back).toHaveBeenCalled();
  expect(Object.keys(usePendingPosts.getState().entries)).toHaveLength(1);
});

it('disables Post over the limit, with the counter and the byte line', async () => {
  await renderCompose();
  type('x'.repeat(23));
  expect(postButton()).toBeDisabled();
  expect(byId('compose-counter')).toHaveAccessibleName('23 of 20 characters, 3 over limit');

  type('😀'.repeat(11));
  expect(postButton()).toBeDisabled();
  expect(screen.getByText('4 bytes over the size limit. Emoji and non-Latin text count extra.')).toBeTruthy();
});

it('is offline: Post disabled and the bar says so', async () => {
  jest.mocked(useNetInfo).mockReturnValue({ isConnected: false } as ReturnType<typeof useNetInfo>);
  await renderCompose();
  type('Hello');
  expect(postButton()).toBeDisabled();
  expect(screen.getByText("You're offline")).toBeTruthy();
  expect(screen.queryByTestId('compose-add-part')).toBeNull();
});

it('builds a thread: add, count, remove', async () => {
  fakeEngine.method('posts.publish').mockResolvedValue(ticket({ op: 'post.publish' }));
  await renderCompose();
  type('one');
  fireEvent.press(byId('compose-add-part'));
  type('two', 1);
  expect(screen.getByText('Post all (2)')).toBeTruthy();
  expect(byId('compose-input-1').props.placeholder).toBe('Continue your thread...');

  fireEvent.press(byId('compose-add-part'));
  fireEvent.press(byId('compose-remove-2'));
  expect(screen.queryByTestId('compose-input-2')).toBeNull();

  await act(async () => fireEvent.press(postButton()));
  expect(fakeEngine.method('posts.publish')).toHaveBeenCalledWith(
    expect.objectContaining({ parts: [{ text: 'one' }, { text: 'two' }] }),
  );
});

it('sets the NSFW flag', async () => {
  fakeEngine.method('posts.publish').mockResolvedValue(ticket({ op: 'post.publish' }));
  await renderCompose();
  type('spicy');
  fireEvent.press(byId('compose-nsfw'));
  expect(byId('compose-nsfw')).toBeChecked();
  await act(async () => fireEvent.press(postButton()));
  expect(fakeEngine.method('posts.publish')).toHaveBeenCalledWith(expect.objectContaining({ sensitive: true }));
});

it('takes a hosted image URL and refuses anything else', async () => {
  fakeEngine.method('posts.publish').mockResolvedValue(ticket({ op: 'post.publish' }));
  await renderCompose();
  type('look');
  fireEvent.press(byId('compose-media-toggle'));
  fireEvent.changeText(byId('compose-media-url'), 'javascript:alert(1)');
  expect(postButton()).toBeDisabled();
  expect(screen.getByText('Use an https:// or ipfs:// link to an image.')).toBeTruthy();

  fireEvent.changeText(byId('compose-media-url'), 'https://example.com/cat.png');
  // The preview follows once typing pauses.
  expect(screen.queryByTestId('compose-media-preview')).toBeNull();
  expect(await screen.findByTestId('compose-media-preview', {}, { timeout: 2000 })).toBeTruthy();
  await act(async () => fireEvent.press(postButton()));
  expect(fakeEngine.method('posts.publish')).toHaveBeenCalledWith(
    expect.objectContaining({ mediaUrl: 'https://example.com/cat.png' }),
  );
});

it('restores the draft, and closing asks Save draft / Delete draft', async () => {
  saveDraft(VIEWER_ID, {
    context: POST,
    parts: [{ text: 'kept text', postedId: null }],
    sensitive: true,
    mediaUrl: '',
    updatedAt: Date.now(),
  });
  await renderCompose();
  expect(byId('compose-input-0')).toHaveTextContent('kept text');
  expect(byId('compose-nsfw')).toBeChecked();

  fireEvent.press(byId('compose-close'));
  expect(sheet?.options).toEqual(['Save draft', 'Delete draft', 'Cancel']);
  act(() => sheet?.choose('Delete draft'));
  expect(loadDraft(VIEWER_ID, POST)).toBeNull();
  expect(router.back).toHaveBeenCalled();
});

it('holds a native dismissal (a swipe) for Save draft / Delete draft / Cancel (COMP-09)', async () => {
  await renderCompose();
  type('swiped text');
  const pop = { type: 'POP' };

  act(() => mockPreventRemove?.({ data: { action: pop } }));
  expect(sheet?.options).toEqual(['Save draft', 'Delete draft', 'Cancel']);
  act(() => sheet?.choose('Cancel'));
  expect(mockNavigation.dispatch).not.toHaveBeenCalled();
  expect(byId('compose-input-0')).toHaveTextContent('swiped text');

  act(() => mockPreventRemove?.({ data: { action: pop } }));
  act(() => sheet?.choose('Save draft'));
  expect(loadDraft(VIEWER_ID, POST)?.parts[0]?.text).toBe('swiped text');
  expect(mockNavigation.dispatch).toHaveBeenCalledWith(pop);
});

it('saves the draft 500 ms after a change', async () => {
  jest.useFakeTimers();
  await renderCompose();
  type('draft me');
  act(() => jest.advanceTimersByTime(600));
  expect(loadDraft(VIEWER_ID, POST)?.parts[0]?.text).toBe('draft me');
  jest.useRealTimers();
});

it('closes an empty composer at once', async () => {
  await renderCompose();
  fireEvent.press(byId('compose-close'));
  expect(sheet).toBeNull();
  expect(router.back).toHaveBeenCalled();
});

it('suggests mentions after 3 characters and inserts the pick', async () => {
  jest.useFakeTimers();
  const sigrid: UserSummaryDTO = { ...AUTHORS.carol, id: 'sig-1', username: 'sigrid', displayName: 'Sigrid' };
  fakeEngine.method('posts.mentionCandidates').mockResolvedValue([sigrid]);
  await renderCompose();
  const input = byId('compose-input-0');
  fireEvent.changeText(input, 'hi @sig');
  fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 7, end: 7 } } });
  await act(async () => {
    jest.advanceTimersByTime(300);
  });
  expect(fakeEngine.method('posts.mentionCandidates')).toHaveBeenCalledWith('sig');
  fireEvent.press(await screen.findByTestId('mention-sigrid'));
  expect(byId('compose-input-0')).toHaveTextContent('hi @sigrid');
  jest.useRealTimers();
});

it('replies: the target preview, "Reply", and the reply target', async () => {
  const target = fixturePost({ id: 'target-1', author: AUTHORS.bob });
  queryClient.setQueryData(queryKeys.post.detail('target-1'), target);
  fakeEngine.method('posts.get').mockResolvedValue(target);
  fakeEngine.method('posts.publish').mockResolvedValue(ticket({ op: 'post.publish' }));
  jest.mocked(useLocalSearchParams).mockReturnValue({ replyTo: 'target-1' });
  await renderCompose();

  expect(screen.getByText('Reply')).toBeTruthy();
  expect(byId('compose-input-0').props.placeholder).toBe('Post your reply');
  expect(screen.queryByTestId('compose-add-part')).toBeNull();
  expect(byId('compose-reply-context')).toHaveTextContent(`Replying to @${AUTHORS.bob.username}`, { exact: false });

  type('agreed');
  await act(async () => fireEvent.press(postButton()));
  expect(fakeEngine.method('posts.publish')).toHaveBeenCalledWith(
    expect.objectContaining({ replyTo: expect.objectContaining({ id: 'target-1', ownerId: AUTHORS.bob.id }) }),
  );
});

it('quotes: the embed and "Add a comment"', async () => {
  const target = fixturePost({ id: 'target-2' });
  queryClient.setQueryData(queryKeys.post.detail('target-2'), target);
  fakeEngine.method('posts.get').mockResolvedValue(target);
  jest.mocked(useLocalSearchParams).mockReturnValue({ quote: 'target-2' });
  await renderCompose();
  expect(byId('compose-input-0').props.placeholder).toBe('Add a comment');
  expect(byId('compose-quote')).toBeTruthy();
});

it('posting a draft that came back from a failed post replaces that card', async () => {
  jest.useFakeTimers();
  fakeEngine.method('posts.publish').mockResolvedValue(ticket({ op: 'post.publish' }));
  usePendingPosts.setState({
    entries: { 'pending-old': { localId: 'pending-old', identityId: VIEWER_ID } as never },
  });
  saveDraft(VIEWER_ID, {
    context: POST,
    parts: [{ text: 'came back', postedId: null }],
    sensitive: false,
    mediaUrl: '',
    updatedAt: Date.now(),
    fromPending: 'pending-old',
  });
  await renderCompose();
  // Saved unedited, the draft keeps its link to the failed post.
  act(() => jest.advanceTimersByTime(600));
  expect(loadDraft(VIEWER_ID, POST)?.fromPending).toBe('pending-old');
  type('came back, edited');
  act(() => jest.advanceTimersByTime(600));
  expect(loadDraft(VIEWER_ID, POST)?.fromPending).toBeUndefined();

  await act(async () => fireEvent.press(postButton()));
  expect(usePendingPosts.getState().entries['pending-old']).toBeUndefined();
  expect(Object.keys(usePendingPosts.getState().entries)).toHaveLength(1);
  jest.useRealTimers();
});

it('removing the focused part moves the counter to the part that takes the focus', async () => {
  await renderCompose();
  type('one');
  fireEvent.press(byId('compose-add-part'));
  fireEvent(byId('compose-input-1'), 'focus');
  type('a longer second part', 1);
  expect(byId('compose-counter')).toHaveAccessibleName('20 of 20 characters');

  fireEvent.press(byId('compose-remove-1'));
  expect(byId('compose-counter')).toHaveAccessibleName('3 of 20 characters');
});

it('a target that could not be read is not "deleted": it offers Retry', async () => {
  fakeEngine.method('posts.get').mockResolvedValue(null);
  jest.mocked(useLocalSearchParams).mockReturnValue({ replyTo: 'target-3' });
  await renderCompose();
  expect(byId('compose-target-unread')).toHaveTextContent("Couldn't load the post", { exact: false });
  expect(screen.queryByText("This post was deleted, so it can't be replied to.")).toBeNull();
  type('hi');
  expect(postButton()).toBeDisabled();

  const target = fixturePost({ id: 'target-3', author: AUTHORS.bob });
  fakeEngine.method('posts.get').mockResolvedValue(target);
  await act(async () => fireEvent.press(screen.getByText('Retry')));
  expect(screen.queryByTestId('compose-target-unread')).toBeNull();
  expect(postButton()).toBeEnabled();
});

it('a deleted target says so', async () => {
  fakeEngine.method('posts.get').mockResolvedValue(fixturePost({ id: 'target-4', deleted: true }));
  jest.mocked(useLocalSearchParams).mockReturnValue({ replyTo: 'target-4' });
  await renderCompose();
  expect(screen.getByText("This post was deleted, so it can't be replied to.")).toBeTruthy();
});

it("edits a failed post on a slot of its own, leaving the context's draft alone", async () => {
  jest.useFakeTimers();
  fakeEngine.method('posts.publish').mockResolvedValue(ticket({ op: 'post.publish' }));
  usePendingPosts.setState({
    entries: {
      'pending-a': {
        localId: 'pending-a',
        identityId: VIEWER_ID,
        context: POST,
        draft: { parts: [{ text: 'Post A' }], sensitive: false, mediaUrl: null, resume: null },
        ticket: null,
        ticketId: null,
        refused: true,
      } as never,
    },
  });
  saveDraft(VIEWER_ID, { context: POST, parts: [{ text: 'Draft B', postedId: null }], sensitive: false, mediaUrl: '', updatedAt: Date.now() });
  jest.mocked(useLocalSearchParams).mockReturnValue({ pending: 'pending-a' });
  await renderCompose();
  expect(byId('compose-input-0').props.value ?? byId('compose-input-0').props.children).toBe('Post A');
  type('Post A, edited');
  act(() => jest.advanceTimersByTime(600));
  expect(loadDraft(VIEWER_ID, POST)?.parts[0]?.text).toBe('Draft B');

  await act(async () => fireEvent.press(postButton()));
  expect(usePendingPosts.getState().entries['pending-a']).toBeUndefined();
  expect(fakeEngine.method('posts.publish')).toHaveBeenCalledWith(expect.objectContaining({ parts: [{ text: 'Post A, edited' }] }));
  expect(loadDraft(VIEWER_ID, POST)?.parts[0]?.text).toBe('Draft B');
  expect(loadDraft(VIEWER_ID, { ...POST, pendingId: 'pending-a' })).toBeNull();
  jest.useRealTimers();
});
