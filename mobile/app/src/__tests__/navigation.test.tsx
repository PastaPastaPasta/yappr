import { router, type Href } from 'expo-router';
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { useSignInPrompt } from '~/data/require-auth';
import { useOnboarding } from '~/features/auth/onboarding';

// Resolved against Jest's cwd, mobile/app.
const APP_DIR = './src/app';
const TABS = ['Home', 'Explore', 'Notifications', 'Messages', 'Profile'];
/** A valid identity id: links are validated before they reach a route. */
const ID = '4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF';

/** Renders the real route tree, then lets the persisted query cache finish restoring. */
async function renderApp(initialUrl: string) {
  const app = renderRouter(APP_DIR, { initialUrl });
  await act(async () => {});
  return app;
}

// Jest renders for iOS, where a tab button's label is "Home, tab, 1 of 5".
const tab = (name: string) => screen.getByLabelText(new RegExp(`^${name}, tab`));

describe('app shell', () => {
  // Past Welcome, as every launch after the first (the fresh install is tested below).
  beforeEach(() => useOnboarding.setState({ welcomed: true }));

  it('opens Welcome on a fresh install (AUTH-01)', async () => {
    useOnboarding.setState({ welcomed: false });
    const app = await renderApp('/');

    expect(app.getPathname()).toBe('/welcome');
    fireEvent.press(screen.getByTestId('welcome-browse'));
    expect(app.getPathname()).toBe('/');
    expect(useOnboarding.getState().welcomed).toBe(true);
  });

  it('opens on Home with the five labelled tabs (ADR-001 E4)', async () => {
    const app = await renderApp('/');

    expect(app.getPathname()).toBe('/');
    expect(screen.getByTestId('home-header')).toBeTruthy();
    for (const name of TABS) expect(tab(name)).toBeTruthy();
  });

  it('switches tabs', async () => {
    const app = await renderApp('/');

    fireEvent.press(tab('Notifications'));
    expect(app.getPathname()).toBe('/notifications');
    fireEvent.press(tab('Messages'));
    expect(app.getPathname()).toBe('/messages');
  });

  // Signed in, the button opens /compose (features/home/HomeScreen.test.tsx).
  it('asks a signed-out reader to sign in from the floating button (G-8)', async () => {
    const app = await renderApp('/');

    fireEvent.press(screen.getByTestId('compose-fab'));
    expect(useSignInPrompt.getState().open).toBe(true);
    expect(app.getPathname()).toBe('/');
    act(() => useSignInPrompt.setState({ open: false }));
  });

  it('pushes shared detail screens onto the current tab and keeps each tab’s history', async () => {
    const app = await renderApp('/');

    fireEvent.press(tab('Explore'));
    act(() => router.push('/post/abc123'));
    expect(app.getSegments()).toEqual(['(tabs)', '(explore)', 'post', '[id]']);

    fireEvent.press(tab('Home'));
    expect(app.getPathname()).toBe('/');
    fireEvent.press(tab('Explore'));
    expect(app.getPathname()).toBe('/post/abc123');

    act(() => router.back());
    expect(app.getPathname()).toBe('/explore');
  });

  it('opens a profile from a conversation and goes back to the conversation', async () => {
    const app = await renderApp('/');

    fireEvent.press(tab('Messages'));
    act(() => router.push('/messages/c1'));
    act(() => router.push('/user/abc123'));
    expect(app.getSegments()).toEqual(['(tabs)', '(messages)', 'user', '[id]']);

    act(() => router.back());
    expect(app.getPathname()).toBe('/messages/c1');
    act(() => router.back());
    expect(app.getPathname()).toBe('/messages');
  });

  it('opens cold links to shared screens in Home, with Home underneath', async () => {
    const app = await renderApp(`/user/${ID}/followers`);

    expect(app.getSegments()).toEqual(['(tabs)', '(home)', 'user', '[id]', 'followers']);
    act(() => router.back());
    expect(app.getPathname()).toBe('/');
  });

  it('keeps links from opening sensitive screens', async () => {
    for (const url of ['/compose?text=hi', '/sign-in/key', '/settings/app-lock', '/lockdown']) {
      const app = await renderApp(url);
      expect(app.getPathname()).toBe('/');
    }
  });

  it('sends unknown routes home', async () => {
    const app = await renderApp('/no/such/route');

    expect(app.getPathname()).toBe('/');
  });

  // Every 1.0 screen has a reachable stub (EXECUTION M1 exit check). Reached
  // in-app, since links may not open some of them (+native-intent).
  it.each([
    ['/', null],
    ['/explore', 'explore and search'],
    ['/explore/search?q=dash', 'explore and search'],
    ['/explore/search/people?q=dash', 'explore and search'],
    ['/notifications', null],
    ['/messages', 'messages'],
    ['/messages/settings', 'messages'],
    ['/messages/c1', 'messages'],
    ['/messages/c1/info', 'messages'],
    ['/messages/new', 'messages'],
    ['/messages/new-group', 'messages'],
    ['/profile', 'profiles'],
    ['/profile/edit', 'profiles'],
    ['/post/abc123', null],
    ['/post/abc123/engagements?kind=post', null],
    ['/user/abc123', 'profiles'],
    ['/user/abc123/followers', 'profiles'],
    ['/user/abc123/following', 'profiles'],
    ['/hashtag/dash', 'explore and search'],
    ['/bookmarks', 'settings and bookmarks'],
    ['/settings', null],
    ['/settings/account', null],
    ['/settings/accounts', null],
    ['/settings/app-lock', null],
    ['/settings/notifications', null],
    ['/settings/privacy', null],
    ['/settings/blocked', null],
    ['/settings/appearance', null],
    ['/settings/about', null],
    ['/settings/diagnostics', null],
    ['/compose', 'compose'],
    ['/media?postId=abc123&index=0', null],
    ['/terms-gate', null],
    ['/lockdown', null],
    ['/webview-update', null],
    ['/sign-in', null],
    ['/sign-in/wallet', null],
    ['/sign-in/qr', null],
    ['/sign-in/register', null],
    ['/sign-in/key', null],
    ['/welcome', null],
    ['/__gallery', null],
    ['/block/abc123', null],
    ['/report/abc123?kind=post', null],
  ])('%s has a stub', async (url, pr) => {
    const app = await renderApp('/');
    act(() => router.push(url as Href));

    expect(app.getPathname()).toBe(url.split('?')[0]);
    if (pr) expect(screen.getByText(`Coming in the ${pr} PR`)).toBeTruthy();
  });
});
