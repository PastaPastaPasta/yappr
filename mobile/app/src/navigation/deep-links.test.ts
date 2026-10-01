import { FALLBACK_ROUTE, toAppRoute, type LinkOptions } from './deep-links';

const X = '4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF';
const Y = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';
const CONVO = '8bGeMG2wFqjJ4V';

/** A release testnet build handling a warm link (the app is already open). */
const release: LinkOptions = { initial: false, webBasePath: '', allowAppRoutes: false };
const cold: LinkOptions = { ...release, initial: true };
const devnet: LinkOptions = { ...release, webBasePath: '/devnet' };
const dev: LinkOptions = { ...release, allowAppRoutes: true };

describe('toAppRoute: web links', () => {
  it.each([
    [`https://yap.pr/post?id=${X}&reply=${Y}`, `/post/${X}?reply=${Y}`],
    [`https://yap.pr/post?id=${X}`, `/post/${X}`],
    [`https://yap.pr/user?id=${X}`, `/user/${X}`],
    ['https://yap.pr/hashtag?tag=dash', '/hashtag/dash'],
    ['https://yap.pr/hashtag?tag=DASH', '/hashtag/dash'],
    ['https://yap.pr/hashtag?tag=%24DASH', '/hashtag/%24dash'],
    [`https://yap.pr/followers?id=${X}`, `/user/${X}/followers`],
    [`https://yap.pr/following?id=${X}`, `/user/${X}/following`],
    [`https://yap.pr/messages?startConversation=${X}`, `/messages/new?with=${X}`],
    [`https://yap.pr/post/engagements?id=${X}&kind=reply`, `/post/${X}/engagements?kind=reply`],
    [`yappr://post?id=${X}`, `/post/${X}`],
    [`yappr-beta://user/?id=${X}`, `/user/${X}`],
    ['https://yap.pr/', '/'],
    ['https://yap.pr/feed', '/'],
    ['yappr://explore', '/explore'],
    ['yappr://notifications', '/notifications'],
    ['yappr://messages', '/messages'],
    ['https://yap.pr/login', '/sign-in'],
    ['https://yap.pr/search?q=hello%20world', '/explore/search?q=hello%20world'],
    [`https://yap.pr/mentions?user=${X}`, `/user/${X}?tab=mentions`],
    ['https://yap.pr/settings?section=privacy', '/settings/privacy'],
    ['https://yap.pr/settings?section=wallet', '/settings'],
  ])('%s → %s', (url, route) => {
    expect(toAppRoute(url, release)).toBe(route);
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
  ])('rejects %s', (url) => {
    expect(toAppRoute(url, release)).toBe(FALLBACK_ROUTE);
  });

  it('drops a reply id that is not an id', () => {
    expect(toAppRoute(`yappr://post?id=${X}&reply=nope`, release)).toBe(`/post/${X}`);
  });
});

describe('toAppRoute: path-form detail links', () => {
  it.each([
    [`yappr://post/${X}`, `/post/${X}`],
    [`yappr://post/${X}?reply=${Y}&utm=x`, `/post/${X}?reply=${Y}`],
    [`yappr://post/${X}/engagements?kind=post`, `/post/${X}/engagements?kind=post`],
    [`yappr://user/${X}`, `/user/${X}`],
    [`yappr://user/${X}?tab=mentions`, `/user/${X}?tab=mentions`],
    [`yappr://user/${X}/followers`, `/user/${X}/followers`],
    ['yappr://hashtag/Dash', '/hashtag/dash'],
    [`yappr://messages/${CONVO}`, `/messages/${CONVO}`],
  ])('%s → %s', (url, route) => {
    expect(toAppRoute(url, release)).toBe(route);
  });

  it.each([
    ['yappr:///post/not-an-id'],
    [`yappr://post/${X}/likes`],
    [`yappr://user/${X}/settings`],
    ['yappr://hashtag/a.b'],
    ['yappr://messages/0OIl'],
    [`yappr://messages/${CONVO}/info`],
  ])('rejects %s', (url) => {
    expect(toAppRoute(url, release)).toBe(FALLBACK_ROUTE);
  });
});

describe('toAppRoute: other app routes', () => {
  const sensitive = [
    'https://yap.pr/sign-in/key?wif=abc',
    'yappr://sign-in',
    'yappr://compose?mode=post&text=hi',
    'yappr://lockdown',
    'yappr://terms-gate',
    'yappr://settings/app-lock',
    'yappr://settings/accounts',
    `yappr://media?postId=${X}&index=0`,
    `yappr://block/${X}`,
    `yappr://report/${X}?kind=post`,
  ];

  it.each([...sensitive, 'yappr-dev:///__gallery', 'yappr://settings/privacy', 'yappr://messages/new'])(
    'release builds refuse %s',
    (url) => {
      expect(toAppRoute(url, release)).toBe(FALLBACK_ROUTE);
    },
  );

  it.each(sensitive)('dev builds still refuse %s', (url) => {
    expect(toAppRoute(url, dev)).toBe(FALLBACK_ROUTE);
  });

  it.each([
    ['yappr-dev:///__gallery', '/__gallery'],
    ['yappr-dev:///settings/appearance', '/settings/appearance'],
  ])('dev builds pass %s through', (url, route) => {
    expect(toAppRoute(url, dev)).toBe(route);
  });

  it("sends the dev client's launch link home", () => {
    const url = 'exp+yappr://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8091';
    expect(toAppRoute(url, { ...dev, initial: true })).toBe(FALLBACK_ROUTE);
  });
});

describe('toAppRoute: cold vs warm links', () => {
  it('pins detail screens to Home for the launch link only', () => {
    expect(toAppRoute(`yappr://post?id=${X}`, cold)).toBe(`/(home)/post/${X}`);
    expect(toAppRoute(`yappr://user/${X}/followers`, cold)).toBe(`/(home)/user/${X}/followers`);
    expect(toAppRoute(`yappr://post?id=${X}`, release)).toBe(`/post/${X}`);
  });

  it('leaves tab roots and conversations alone', () => {
    expect(toAppRoute('yappr://explore', cold)).toBe('/explore');
    expect(toAppRoute(`yappr://messages/${CONVO}`, cold)).toBe(`/messages/${CONVO}`);
  });
});

describe('toAppRoute: web base paths', () => {
  it('devnet builds claim /devnet', () => {
    expect(toAppRoute(`https://yap.pr/devnet/post?id=${X}`, devnet)).toBe(`/post/${X}`);
    expect(toAppRoute('https://yap.pr/devnet', devnet)).toBe('/');
    // Scheme links carry no prefix.
    expect(toAppRoute(`yappr-dev://post?id=${X}`, devnet)).toBe(`/post/${X}`);
  });

  it("refuses another deployment's links", () => {
    expect(toAppRoute(`https://yap.pr/testing/post?id=${X}`, devnet)).toBe(FALLBACK_ROUTE);
    expect(toAppRoute(`https://yap.pr/devnet/post?id=${X}`, release)).toBe(FALLBACK_ROUTE);
    expect(toAppRoute(`https://yap.pr/testing/user?id=${X}`, release)).toBe(FALLBACK_ROUTE);
  });
});
