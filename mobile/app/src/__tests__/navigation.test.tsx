import { router, type Href } from 'expo-router';
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

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
  it('opens on Home with the five labelled tabs (ADR-001 E4)', async () => {
    const app = await renderApp('/');

    expect(app.getPathname()).toBe('/');
    expect(screen.getByText('Coming in the feed PR')).toBeTruthy();
    for (const name of TABS) expect(tab(name)).toBeTruthy();
  });

  it('switches tabs', async () => {
    const app = await renderApp('/');

    fireEvent.press(tab('Notifications'));
    expect(app.getPathname()).toBe('/notifications');
    fireEvent.press(tab('Messages'));
    expect(app.getPathname()).toBe('/messages');
  });

  it('opens compose from the floating button', async () => {
    const app = await renderApp('/');

    fireEvent.press(screen.getByTestId('compose-fab'));
    expect(app.getPathname()).toBe('/compose');
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
    ['/', 'feed'],
    ['/explore', null],
    ['/explore/search?q=dash', null],
    ['/explore/search/people?q=dash', null],
    ['/notifications', 'notifications'],
    ['/messages', 'messages'],
    ['/messages/settings', 'messages'],
    ['/messages/c1', 'messages'],
    ['/messages/c1/info', 'messages'],
    ['/messages/new', 'messages'],
    ['/messages/new-group', 'messages'],
    ['/profile', 'profiles'],
    ['/profile/edit', 'profiles'],
    ['/post/abc123', 'post detail'],
    ['/post/abc123/engagements?kind=post', 'post detail'],
    ['/user/abc123', 'profiles'],
    ['/user/abc123/followers', 'profiles'],
    ['/user/abc123/following', 'profiles'],
    ['/hashtag/dash', null],
    ['/bookmarks', 'settings and bookmarks'],
    ['/settings', 'settings and bookmarks'],
    ['/settings/account', 'settings and bookmarks'],
    ['/settings/accounts', 'sign-in'],
    ['/settings/app-lock', 'sign-in'],
    ['/settings/notifications', 'notifications'],
    ['/settings/privacy', 'settings and bookmarks'],
    ['/settings/blocked', 'safety'],
    ['/settings/appearance', 'settings and bookmarks'],
    ['/settings/about', 'settings and bookmarks'],
    ['/settings/diagnostics', null],
    ['/compose', 'compose'],
    ['/media?postId=abc123&index=0', 'post detail'],
    ['/terms-gate', 'safety'],
    ['/lockdown', null],
    ['/webview-update', null],
    ['/sign-in', 'sign-in'],
    ['/sign-in/wallet', 'sign-in'],
    ['/sign-in/qr', 'sign-in'],
    ['/sign-in/register', 'sign-in'],
    ['/sign-in/key', 'sign-in'],
    ['/welcome', 'sign-in'],
    ['/__gallery', null],
    ['/block/abc123', 'safety'],
    ['/report/abc123?kind=post', 'safety'],
  ])('%s has a stub', async (url, pr) => {
    const app = await renderApp('/');
    act(() => router.push(url as Href));

    expect(app.getPathname()).toBe(url.split('?')[0]);
    if (pr) expect(screen.getByText(`Coming in the ${pr} PR`)).toBeTruthy();
  });
});
