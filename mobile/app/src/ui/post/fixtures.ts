import { FIXTURE_AVATARS } from './fixture-avatars';
import type { CardAuthor, CardLinkPreview, CardPoll, CardPost } from './types';

/**
 * PostDTO-shaped sample data for the gallery and the tests. Times are
 * relative to when the module loads.
 */

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);

function author(key: keyof typeof FIXTURE_AVATARS, displayName: string, username: string | null): CardAuthor {
  const { id, uri } = FIXTURE_AVATARS[key];
  return { id, username, displayName, avatarUrl: uri, resolved: true };
}

export const AUTHORS = {
  alice: author('alice', 'Alice', 'alice'),
  bob: author('bob', 'Bob Builder', 'bob'),
  carol: author('carol', 'Carol', 'carol'),
  /** No DPNS name and no profile: the header shows the truncated id. */
  nameless: author('nameless', 'User mJzE', null),
};

export const VIEWER_ID = AUTHORS.alice.id;

export function fixturePost(overrides: Partial<CardPost> = {}): CardPost {
  return {
    id: 'post-basic',
    kind: 'post',
    author: AUTHORS.bob,
    content: 'Shipping the design system today. #yappr',
    createdAt: ago(3 * HOUR),
    stats: { likes: 48, reposts: 3, replies: 12, quotes: 0 },
    viewer: { liked: false, reposted: false, bookmarked: false, authorBlocked: false, followsAuthor: true },
    media: [],
    sensitive: false,
    deleted: false,
    encrypted: false,
    quotedRemoved: false,
    ...overrides,
  };
}

const IMAGE = (id: number, w = 1200, h = 675) => ({
  type: 'image' as const,
  url: `https://picsum.photos/id/${id}/${w}/${h}`,
  width: w,
  height: h,
  alt: `Sample photo ${id}`,
});

export const SAMPLE_PREVIEW: CardLinkPreview = {
  url: 'https://www.dash.org/platform/',
  title: 'Dash Platform: decentralized data and apps',
  description: 'Build web3 apps with a decentralized database, usernames and identities on Dash.',
  image: 'https://picsum.photos/id/1043/1200/630',
  siteName: 'dash.org',
};

export const SAMPLE_POLL: CardPoll = {
  question: 'Which tab do you open first?',
  options: [
    { label: 'Home', votes: 31 },
    { label: 'Explore', votes: 12 },
    { label: 'Messages', votes: 7 },
  ],
  totalVotes: 50,
  endsAt: new Date(Date.now() + 2 * 24 * HOUR + HOUR),
};

/** Every PostCard state the gallery shows; the tests use them too. */
export const POSTS = {
  basic: fixturePost({
    id: 'post-basic',
    content:
      'Shipping the native design system today 🎉 Buttons, sheets, toasts and this very card. Thanks @carol for the review! #yappr $DASH https://yap.pr',
  }),
  liked: fixturePost({
    id: 'post-liked',
    author: AUTHORS.carol,
    content: 'Liked, reposted and bookmarked: the active colors.',
    stats: { likes: 1234, reposts: 56, replies: 7, quotes: 4 },
    viewer: { liked: true, reposted: true, bookmarked: true, authorBlocked: false, followsAuthor: true },
    createdAt: ago(25 * 60_000),
  }),
  repost: fixturePost({
    id: 'post-repost',
    content: 'Reposted into your feed.',
    repostedBy: { id: AUTHORS.carol.id, username: 'carol', displayName: 'Carol' },
  }),
  nameless: fixturePost({
    id: 'post-nameless',
    author: AUTHORS.nameless,
    content: 'No username yet: the header shows my identity id. Tap it to copy.',
    stats: { likes: 0, reposts: 0, replies: 0, quotes: 0 },
  }),
  markdown: fixturePost({
    id: 'post-markdown',
    author: AUTHORS.alice,
    content:
      'Markdown subset: **bold with #tag**, *italic*, `inline code`.\nمرحبا بالعالم — RTL text stays readable.\nwww.dash.org.',
  }),
  emoji: fixturePost({
    id: 'post-emoji',
    author: AUTHORS.carol,
    content: '🚀🔥👩‍💻',
    stats: { likes: 5, reposts: 0, replies: 1, quotes: 0 },
  }),
  quote: fixturePost({
    id: 'post-quote',
    content: 'This is the thread to read.',
    quotedPostId: 'post-quoted',
    quoted: fixturePost({
      id: 'post-quoted',
      author: AUTHORS.carol,
      content:
        'Every primitive in the app now matches web class for class, from the button scale to the toast position. Long quoted text clamps at four lines so the card stays compact in the feed.',
      media: [IMAGE(1015)],
      createdAt: ago(26 * HOUR),
    }),
  }),
  quoteRemoved: fixturePost({
    id: 'post-quote-removed',
    content: 'Quoting something that is gone.',
    quotedPostId: 'gone',
    quotedRemoved: true,
  }),
  oneImage: fixturePost({ id: 'post-1img', content: 'One image keeps its own shape.', media: [IMAGE(1018)] }),
  twoImages: fixturePost({
    id: 'post-2img',
    content: 'Two side by side.',
    media: [IMAGE(1025), IMAGE(1035)],
  }),
  threeImages: fixturePost({
    id: 'post-3img',
    content: 'Three: the first spans both rows.',
    media: [IMAGE(1039), IMAGE(1043), IMAGE(1050)],
  }),
  fourImages: fixturePost({
    id: 'post-4img',
    content: 'Four in a grid.',
    media: [IMAGE(1060), IMAGE(1067), IMAGE(1069), IMAGE(1074)],
  }),
  linkPreview: fixturePost({
    id: 'post-link',
    content: 'Read up on Platform: https://www.dash.org/platform/',
  }),
  youtube: fixturePost({ id: 'post-yt', content: 'Watch this https://www.youtube.com/watch?v=jNQXAC9IVRw' }),
  poll: fixturePost({ id: 'post-poll', author: AUTHORS.carol, content: 'Quick poll!' }),
  nsfw: fixturePost({
    id: 'post-nsfw',
    content: 'Flagged by the author as sensitive.',
    sensitive: true,
    media: [IMAGE(1084)],
  }),
  mediaGated: fixturePost({
    id: 'post-gated',
    author: AUTHORS.carol,
    content: 'You don’t follow me, so my image waits for a tap.',
    media: [IMAGE(1080)],
  }),
  private: fixturePost({ id: 'post-private', author: AUTHORS.carol, content: '', encrypted: true }),
  tombstone: fixturePost({ id: 'post-tombstone', content: '', deleted: true }),
  reply: fixturePost({
    id: 'post-reply',
    kind: 'reply',
    content: 'Agreed, ship it.',
    parentId: 'post-basic',
  }),
  optimistic: fixturePost({
    id: 'post-optimistic',
    author: AUTHORS.alice,
    content: 'Just posted from the app.',
    createdAt: new Date(),
  }),
  /** A real testnet post (yap.pr/post?id=4NeHEz…), mirrored for the web side-by-side. */
  webParity: fixturePost({
    id: '4NeHEzYg8xPbhXEgL4nXYmBwJysrQrwLNs9zE74HXMZB',
    author: author('pasta', 'Pasta', 'pasta'),
    content: 'Just got done presenting at DashCon! It was super fun!\n\n(Presentation links incoming below)',
    createdAt: new Date('2026-09-03T15:00:00Z'),
    stats: { likes: 4, reposts: 0, replies: 2, quotes: 0 },
  }),
  long: fixturePost({
    id: 'post-long',
    author: AUTHORS.alice,
    content: Array.from({ length: 16 }, (_, i) => `Line ${i + 1} of a long post that the feed clamps.`).join(
      '\n',
    ),
  }),
};
