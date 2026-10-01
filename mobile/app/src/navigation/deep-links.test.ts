import { FALLBACK_ROUTE, toAppRoute } from './deep-links';

const X = '4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF';
const Y = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';

describe('toAppRoute', () => {
  it.each([
    // The lead's M1 list.
    [`https://yap.pr/post?id=${X}&reply=${Y}`, `/(home)/post/${X}?reply=${Y}`],
    [`https://yap.pr/post?id=${X}`, `/(home)/post/${X}`],
    [`https://yap.pr/user?id=${X}`, `/(home)/user/${X}`],
    ['https://yap.pr/hashtag?tag=dash', '/(home)/hashtag/dash'],
    ['https://yap.pr/hashtag?tag=%24DASH', '/(home)/hashtag/%24DASH'],
    [`https://yap.pr/followers?id=${X}`, `/(home)/user/${X}/followers`],
    [`https://yap.pr/following?id=${X}`, `/(home)/user/${X}/following`],
    [`https://yap.pr/messages?startConversation=${X}`, `/messages/new?with=${X}`],
    [`https://yap.pr/post/engagements?id=${X}&kind=reply`, `/(home)/post/${X}/engagements?kind=reply`],
    // The same paths over the app scheme, and under the web's base paths.
    [`yappr://post?id=${X}`, `/(home)/post/${X}`],
    [`yappr-dev://user?id=${X}`, `/(home)/user/${X}`],
    [`https://yap.pr/devnet/post?id=${X}`, `/(home)/post/${X}`],
    [`https://yap.pr/testing/user/?id=${X}`, `/(home)/user/${X}`],
    // Tab roots and the rest of UX_SPEC §3.5.
    ['https://yap.pr/', '/'],
    ['https://yap.pr/feed', '/'],
    ['yappr://explore', '/explore'],
    ['yappr://notifications', '/notifications'],
    ['yappr://messages', '/messages'],
    ['https://yap.pr/login', '/sign-in'],
    ['https://yap.pr/search?q=hello%20world', '/explore/search?q=hello%20world'],
    [`https://yap.pr/mentions?user=${X}`, `/(home)/user/${X}?tab=mentions`],
    ['https://yap.pr/settings?section=privacy', '/settings/privacy'],
    ['https://yap.pr/settings?section=wallet', '/settings'],
    // App routes pass through untouched.
    ['yappr-dev:///__gallery', '/__gallery'],
    [`yappr-dev:///post/${X}/engagements?kind=post`, `/(home)/post/${X}/engagements?kind=post`],
    ['/settings/appearance', '/settings/appearance'],
  ])('%s → %s', (url, route) => {
    expect(toAppRoute(url)).toBe(route);
  });

  it.each([
    ['https://yap.pr/post?id=not-an-id'],
    ['https://yap.pr/post'],
    [`https://yap.pr/post?id=${X}0`],
    [`https://yap.pr/post/engagements?id=${X}&kind=evil`],
    ['https://yap.pr/hashtag?tag=a%2Fb'],
    ['https://yap.pr/hashtag?tag=%E0%A4%A'],
    ['https://yap.pr/user?id=%2E%2E%2Fsettings'],
    ['https://yap.pr/store/view?id=1'],
    ['https://yap.pr/terms'],
    ['exp+yappr://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8091'],
  ])('rejects %s', (url) => {
    expect(toAppRoute(url)).toBe(FALLBACK_ROUTE);
  });

  it('drops a reply id that is not an id', () => {
    expect(toAppRoute(`yappr://post?id=${X}&reply=nope`)).toBe(`/(home)/post/${X}`);
  });
});
