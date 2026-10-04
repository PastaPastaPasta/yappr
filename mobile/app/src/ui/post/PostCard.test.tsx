import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { singleAspectRatio } from './MediaGrid';
import { displayHost } from './LinkPreviewCard';
import { pollEndLabel, pollPercents } from './PollCard';
import { PostCard } from './PostCard';
import { PostStub, stubText } from './PostStub';
import { AUTHORS, POSTS, SAMPLE_POLL, SAMPLE_PREVIEW, VIEWER_ID, fixturePost } from './fixtures';

const hidden = { includeHiddenElements: true };

/** React Native's Jest setup reports fontScale 2, an accessibility size; default to 1. */
let mockFontScale = 1;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 390, height: 844, scale: 3, fontScale: mockFontScale }),
}));
function setFontScale(fontScale: number) {
  mockFontScale = fontScale;
}
beforeEach(() => setFontScale(1));

// The card is one accessible element, so query its controls by test id.
const byId = (id: string) => screen.getByTestId(id);

describe('PostCard (feed)', () => {
  it('shows the author line, text and formatted counts', () => {
    render(<PostCard post={POSTS.liked} />);
    expect(screen.getByText('Carol')).toBeTruthy();
    expect(screen.getByText('@carol')).toBeTruthy();
    expect(screen.getByText('· 25m')).toBeTruthy();
    expect(screen.getByText('1.2K')).toBeTruthy();
    // Reposts plus quotes: 56 + 4.
    expect(screen.getByText('60')).toBeTruthy();
  });

  it('labels and toggles the actions, with solid active states', () => {
    const actions = {
      onLike: jest.fn(),
      onReply: jest.fn(),
      onRepost: jest.fn(),
      onBookmark: jest.fn(),
      onShare: jest.fn(),
    };
    const { rerender } = render(<PostCard post={POSTS.basic} actions={actions} />);

    const like = byId('like-btn-post-basic');
    expect(like).toHaveAccessibleName('Like, 48 likes');
    expect(like).not.toBeSelected();
    fireEvent.press(like);
    expect(byId('reply-btn-post-basic')).toHaveAccessibleName('Reply, 12 replies');
    fireEvent.press(byId('reply-btn-post-basic'));
    expect(byId('repost-btn-post-basic')).toHaveAccessibleName('Repost or quote, 3 reposts');
    fireEvent.press(byId('repost-btn-post-basic'));
    expect(byId('bookmark-btn-post-basic')).toHaveAccessibleName('Bookmark');
    fireEvent.press(byId('bookmark-btn-post-basic'));
    expect(byId('share-btn-post-basic')).toHaveAccessibleName('Share');
    fireEvent.press(byId('share-btn-post-basic'));
    for (const fn of Object.values(actions)) expect(fn).toHaveBeenCalledTimes(1);

    rerender(<PostCard post={POSTS.liked} actions={actions} />);
    expect(byId('like-btn-post-liked')).toHaveAccessibleName('Unlike, 1234 likes');
    expect(byId('like-btn-post-liked')).toBeSelected();
    expect(byId('bookmark-btn-post-liked')).toHaveAccessibleName('Remove bookmark');
    expect(byId('bookmark-btn-post-liked')).toBeSelected();
  });

  it('leaves counts blank at zero', () => {
    render(<PostCard post={POSTS.nameless} />);
    expect(byId('like-btn-post-nameless')).toHaveAccessibleName('Like, 0 likes');
    expect(screen.queryByText('0')).toBeNull();
  });

  it('moves counts into the labels at accessibility text sizes', () => {
    setFontScale(2);
    render(<PostCard post={POSTS.liked} />);
    expect(screen.queryByText('1.2K')).toBeNull();
    expect(byId('like-btn-post-liked')).toHaveAccessibleName('Unlike, 1234 likes');
  });

  it('hides the slots the engine says the kind lacks', () => {
    render(<PostCard post={POSTS.reply} canRepost={false} canBookmark={false} />);
    expect(screen.queryByTestId('repost-btn-post-reply')).toBeNull();
    expect(screen.queryByTestId('bookmark-btn-post-reply')).toBeNull();
    expect(byId('reply-btn-post-reply')).toBeTruthy();
  });

  it('opens the post, the author and the menu', () => {
    const actions = { onPress: jest.fn(), onAuthorPress: jest.fn(), onMore: jest.fn() };
    render(<PostCard post={POSTS.reply} actions={actions} />);
    fireEvent.press(screen.getByTestId('post-card-post-reply'));
    fireEvent.press(screen.getByTestId('avatar-post-reply'));
    expect(byId('more-btn-post-reply')).toHaveAccessibleName('Reply options');
    fireEvent.press(byId('more-btn-post-reply'));
    for (const fn of Object.values(actions)) expect(fn).toHaveBeenCalledTimes(1);
  });

  it('summarizes the card for screen readers and exposes its actions', () => {
    const onLike = jest.fn();
    render(<PostCard post={POSTS.repost} viewerId={VIEWER_ID} replyingTo="carol" actions={{ onLike }} />);
    const card = screen.getByTestId('post-card-post-repost');
    expect(card.props.accessibilityLabel).toBe(
      'Bob Builder, @bob, 3 hours ago. Reposted by Carol. Replying to @carol. Reposted into your feed.. 12 replies, 3 reposts, 48 likes.',
    );
    fireEvent(card, 'accessibilityAction', { nativeEvent: { actionName: 'like' } });
    expect(onLike).toHaveBeenCalled();
  });

  it('keeps the spoken time in its screen-reader summary current', () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 9, 3, 12, 0, 30) });
    try {
      render(<PostCard post={{ ...POSTS.liked, createdAt: new Date(Date.now() - 5 * 60_000) }} />);
      const label = () => screen.getByTestId('post-card-post-liked').props.accessibilityLabel as string;
      expect(label()).toContain('5 minutes ago.');
      act(() => jest.advanceTimersByTime(5 * 60_000));
      expect(label()).toContain('10 minutes ago.');
      expect(screen.getByText('· 10m')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('names the reposter, or "You" for the viewer', () => {
    const { rerender } = render(<PostCard post={POSTS.repost} />);
    expect(screen.getByText('Carol')).toBeTruthy();
    rerender(<PostCard post={POSTS.repost} viewerId={AUTHORS.carol.id} />);
    expect(screen.getByText('You')).toBeTruthy();
  });

  it('shows a nameless author’s truncated id, which copies on tap', () => {
    const onCopyId = jest.fn();
    render(<PostCard post={POSTS.nameless} actions={{ onCopyId }} />);
    fireEvent.press(screen.getByText('B2vAkPq8...K1mJzE'));
    expect(onCopyId).toHaveBeenCalled();
    expect(screen.getByText('B2vAkPq8...K1mJzE')).toBeTruthy();
  });

  it('shows skeleton bars while the author resolves, and the time at once', () => {
    render(<PostCard post={POSTS.basic} authorPending />);
    expect(screen.queryByText('Bob Builder')).toBeNull();
    expect(screen.getByText('· 3h')).toBeTruthy();
  });

  it('becomes the blocked stub for a blocked author', () => {
    render(
      <PostCard
        post={fixturePost({
          viewer: {
            liked: false,
            reposted: false,
            bookmarked: false,
            ownQuoteId: null,
            ownQuoteBare: false,
            authorBlocked: true,
            followsAuthor: false,
          },
        })}
      />,
    );
    expect(screen.getByText('Post from an account you blocked')).toBeTruthy();
    // No menu given: no "⋯" and no "More" action.
    expect(screen.queryByTestId('more-menu-post-basic')).toBeNull();
    expect(screen.getByTestId('stub-blocked').props.accessibilityActions).toBeUndefined();
  });
});

describe('PostCard gates', () => {
  it('covers NSFW content, hidden from screen readers until Show', () => {
    render(<PostCard post={POSTS.nsfw} />);
    expect(screen.getByTestId('post-card-post-nsfw').props.accessibilityLabel).toBe('NSFW post, hidden');
    expect(screen.queryByText('Flagged by the author as sensitive.')).toBeNull();
    expect(screen.getByText('Flagged by the author as sensitive.', hidden)).toBeTruthy();

    expect(byId('sensitive-show')).toHaveAccessibleName('Show post flagged as NSFW');
    fireEvent.press(byId('sensitive-show'));
    expect(screen.getByText('Flagged by the author as sensitive.')).toBeTruthy();
    expect(screen.queryByTestId('sensitive-gate')).toBeNull();
  });

  it('gates a quote by the quoted author, not the quoting one', () => {
    render(<PostCard post={POSTS.quote} quoteNsfwGated quoteMediaGated />);
    const card = byId('post-card-post-quote');
    expect(card.props.accessibilityLabel).toContain('Quote: Carol.');
    expect(screen.getByTestId('sensitive-gate')).toBeTruthy();
  });

  it('respects the caller’s NSFW mode', () => {
    render(<PostCard post={{ ...POSTS.nsfw, id: 'nsfw-shown' }} nsfwGated={false} />);
    expect(screen.queryByTestId('sensitive-gate')).toBeNull();
  });

  it('replaces gated media with the placeholder until Show', () => {
    const onRevealMedia = jest.fn();
    render(<PostCard post={POSTS.mediaGated} mediaGated onRevealMedia={onRevealMedia} />);
    expect(screen.getByLabelText("Media hidden. Media from someone you don't follow.")).toBeTruthy();
    expect(screen.queryByTestId('media-grid')).toBeNull();
    fireEvent.press(screen.getByTestId('media-gate-show'));
    expect(onRevealMedia).toHaveBeenCalled();
  });

  it('gates a link-preview image like media, with the Show media action', () => {
    const onRevealMedia = jest.fn();
    render(
      <PostCard post={POSTS.linkPreview} linkPreview={SAMPLE_PREVIEW} mediaGated onRevealMedia={onRevealMedia} />,
    );
    expect(screen.getByTestId('media-gate')).toBeTruthy();
    const card = byId(`post-card-${POSTS.linkPreview.id}`);
    const labels = card.props.accessibilityActions.map((a: { label: string }) => a.label);
    expect(labels).toContain('Show media');
    fireEvent(card, 'accessibilityAction', { nativeEvent: { actionName: 'showMedia' } });
    expect(onRevealMedia).toHaveBeenCalled();
  });

  it('gates quoted media alone behind its own Show, and the Show media action', () => {
    const onRevealMedia = jest.fn();
    // The quoting post has no media of its own: the quote's thumbnail is all there is to reveal.
    render(<PostCard post={POSTS.quote} quoteMediaGated onRevealMedia={onRevealMedia} />);
    expect(screen.queryByTestId('media-gate')).toBeNull();
    fireEvent.press(byId('quote-media-gate'));
    expect(onRevealMedia).toHaveBeenCalledTimes(1);
    const card = byId(`post-card-${POSTS.quote.id}`);
    const labels = card.props.accessibilityActions.map((a: { label: string }) => a.label);
    expect(labels).toContain('Show media');
    fireEvent(card, 'accessibilityAction', { nativeEvent: { actionName: 'showMedia' } });
    expect(onRevealMedia).toHaveBeenCalledTimes(2);
  });

  it('shows the quoted thumbnail, with no Show, when its media is not gated', () => {
    render(<PostCard post={POSTS.quote} onRevealMedia={jest.fn()} />);
    expect(screen.queryByTestId('quote-media-gate')).toBeNull();
    const card = byId(`post-card-${POSTS.quote.id}`);
    expect(card.props.accessibilityActions.map((a: { label: string }) => a.label)).not.toContain('Show media');
  });

  it('renders a private post as the placeholder, with no reply', () => {
    const onOpenPrivate = jest.fn();
    render(<PostCard post={POSTS.private} actions={{ onOpenPrivate }} />);
    expect(screen.getByText('Private post')).toBeTruthy();
    expect(
      screen.getByText("Only Carol's private followers can read this. Private feeds aren't in the app yet."),
    ).toBeTruthy();
    expect(screen.queryByTestId('reply-btn-post-private')).toBeNull();
    fireEvent.press(screen.getByText('Open on yap.pr'));
    expect(onOpenPrivate).toHaveBeenCalled();
  });
});

describe('PostCard embeds', () => {
  it('shows a quote, or the removed stub, the skeleton, or "unavailable"', () => {
    const onQuotePress = jest.fn();
    const { rerender } = render(<PostCard post={POSTS.quote} actions={{ onQuotePress }} />);
    fireEvent.press(screen.getByTestId('quote-embed'));
    expect(onQuotePress).toHaveBeenCalled();

    rerender(<PostCard post={POSTS.quoteRemoved} />);
    expect(screen.getByText("This post was removed by the contract's moderators.")).toBeTruthy();

    rerender(<PostCard post={{ ...POSTS.quoteRemoved, quotedRemoved: false }} quoteLoading />);
    expect(screen.getByTestId('quote-skeleton')).toBeTruthy();

    rerender(<PostCard post={{ ...POSTS.quoteRemoved, quotedRemoved: false }} />);
    expect(screen.getByText('This post is unavailable.')).toBeTruthy();
  });

  it('shows the link preview and drops the link from the text', () => {
    const onLinkPreviewPress = jest.fn();
    render(
      <PostCard post={POSTS.linkPreview} linkPreview={SAMPLE_PREVIEW} actions={{ onLinkPreviewPress }} />,
    );
    expect(screen.queryByText('https://www.dash.org/platform/')).toBeNull();
    fireEvent.press(screen.getByTestId('link-preview'));
    expect(onLinkPreviewPress).toHaveBeenCalledWith(SAMPLE_PREVIEW.url);
  });

  it('keeps the link in the text when the preview failed', () => {
    render(<PostCard post={POSTS.linkPreview} linkPreview="error" />);
    expect(screen.getByText('https://www.dash.org/platform/')).toBeTruthy();
    expect(screen.queryByTestId('link-preview')).toBeNull();
  });

  it('shows the poll results and sends voting to the web', () => {
    const onVotePress = jest.fn();
    render(<PostCard post={POSTS.poll} poll={SAMPLE_POLL} actions={{ onVotePress }} />);
    expect(screen.getByLabelText('Home, 62%')).toBeTruthy();
    expect(screen.getByText('50 votes · Ends in 2d')).toBeTruthy();
    fireEvent.press(screen.getByText('Vote on yap.pr'));
    expect(onVotePress).toHaveBeenCalled();
  });

  it('lays out the media grid for each count', () => {
    for (const [post, cells] of [
      [POSTS.oneImage, 1],
      [POSTS.twoImages, 2],
      [POSTS.threeImages, 3],
      [POSTS.fourImages, 4],
    ] as const) {
      const { unmount } = render(<PostCard post={post} />);
      expect(screen.getAllByRole('imagebutton')).toHaveLength(cells);
      unmount();
    }
  });
});

describe('PostCard variants', () => {
  it('optimistic: the write status replaces the action bar, for screen readers too', () => {
    const onRetry = jest.fn();
    const onLike = jest.fn();
    render(
      <PostCard
        post={POSTS.optimistic}
        variant="optimistic"
        writeStatus={{ status: { state: 'failed' }, onRetry, onEdit: jest.fn() }}
        actions={{ onLike }}
      />,
    );
    expect(screen.queryByTestId('action-bar-post-optimistic')).toBeNull();
    expect(screen.getByText("Couldn't post")).toBeTruthy();
    fireEvent.press(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);

    const card = byId('post-card-post-optimistic');
    const names = card.props.accessibilityActions.map((a: { label: string }) => a.label);
    expect(names).toEqual(expect.arrayContaining(['Retry', 'Edit']));
    expect(names).not.toContain('Like');
    fireEvent(card, 'accessibilityAction', { nativeEvent: { actionName: 'Retry' } });
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('detail: absolute time and the counts row', () => {
    render(<PostCard post={POSTS.liked} variant="detail" />);
    expect(screen.getByText(/\d{1,2}:\d{2} [AP]M · \w{3} \d{1,2}, \d{4}/)).toBeTruthy();
    expect(screen.getByText('56 Reposts')).toBeTruthy();
    expect(screen.getByText('4 Quotes')).toBeTruthy();
    expect(screen.getByText('1.2K Likes')).toBeTruthy();
  });

  it("detail: the repost control and the card's summary read the counts row's repost/quote split (D-L4a-009)", () => {
    // v10: the viewer's own quote with text is the one quote post; the card counts it as a repost.
    const post = fixturePost({
      id: 'own-quoted',
      stats: { likes: 0, reposts: 0, replies: 0, quotes: 1 },
      viewer: { ...POSTS.basic.viewer!, reposted: true, ownQuoteId: 'mine', ownQuoteBare: false },
    });
    const split = { reposts: 0, quotes: 1, truncated: false };
    const { rerender } = render(<PostCard post={post} variant="detail" repostQuoteCounts={split} />);
    expect(screen.getByText('1 Quote')).toBeTruthy();
    expect(byId('repost-btn-own-quoted')).toHaveAccessibleName('Repost or quote, 0 reposts, 1 quote, quoted');
    expect(byId('repost-btn-own-quoted')).toBeSelected();
    expect(byId('post-card-own-quoted').props.accessibilityLabel).toMatch(/0 replies, 0 reposts, 1 quotes, 0 likes\.$/);

    // Floors off a list that filled up, as the row shows them.
    rerender(<PostCard post={post} variant="detail" repostQuoteCounts={{ reposts: 100, quotes: 3, truncated: true }} />);
    expect(byId('repost-btn-own-quoted')).toHaveAccessibleName('Repost or quote, 100+ reposts, 3+ quotes, quoted');

    // Feed cards have no split: the one count the control shows.
    rerender(<PostCard post={post} repostQuoteCounts={split} />);
    expect(byId('repost-btn-own-quoted')).toHaveAccessibleName('Repost or quote, 1 repost, quoted');
    expect(byId('post-card-own-quoted').props.accessibilityLabel).toMatch(/0 replies, 1 reposts, 0 likes\.$/);
  });

  it('compact and tombstoned cards have no action bar', () => {
    const { rerender } = render(<PostCard post={POSTS.basic} variant="compact" />);
    expect(screen.queryByTestId('action-bar-post-basic')).toBeNull();
    rerender(<PostCard post={POSTS.tombstone} />);
    expect(screen.getByText('This post was deleted by its author.')).toBeTruthy();
    expect(screen.queryByTestId('action-bar-post-tombstone')).toBeNull();
  });

  it('feed: clamps long text at 12 lines with "Show more"', () => {
    const onPress = jest.fn();
    render(<PostCard post={POSTS.long} actions={{ onPress }} />);
    expect(screen.queryByTestId('show-more')).toBeNull();
    const body = screen.getByText(/Line 1 of a long post/);
    fireEvent(body, 'textLayout', { nativeEvent: { lines: Array.from({ length: 16 }, () => ({})) } });
    expect(screen.getByText(/Line 1 of a long post/).props.numberOfLines).toBe(12);
    fireEvent.press(screen.getByTestId('show-more'));
    expect(onPress).toHaveBeenCalled();
  });
});

describe('review fixes', () => {
  it('hides a legacy poll link from the text', () => {
    const post = fixturePost({
      id: 'legacy-poll',
      content: 'Vote here https://pollr.app/poll?id=abc',
      poll: { id: 'abc', linkUrl: 'https://pollr.app/poll?id=abc' },
    });
    render(<PostCard post={post} poll={SAMPLE_POLL} />);
    expect(screen.getByText('Vote here')).toBeTruthy();
    expect(screen.queryByText(/pollr\.app/)).toBeNull();
  });

  it('offers the quote, links, mentions, tags and images as screen-reader actions', () => {
    const actions = {
      onQuotePress: jest.fn(),
      onMentionPress: jest.fn(),
      onHashtagPress: jest.fn(),
      onLinkPress: jest.fn(),
      onMediaPress: jest.fn(),
    };
    const post = fixturePost({
      id: 'a11y-targets',
      content: 'Hi @Carol #Dash https://dash.org',
      media: [POSTS.oneImage.media[0]],
      quotedPostId: 'q',
      quoted: POSTS.quote.quoted,
    });
    render(<PostCard post={post} actions={actions} />);
    const card = screen.getByTestId('post-card-a11y-targets');
    const labels = card.props.accessibilityActions.map((a: { label: string }) => a.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        'Open @Carol',
        'Open #Dash',
        'Open https://dash.org',
        'Open quoted post',
        'Open image 1',
      ]),
    );
    const run = (actionName: string) =>
      fireEvent(card, 'accessibilityAction', { nativeEvent: { actionName } });
    run('Open @Carol');
    run('Open #Dash');
    run('Open https://dash.org');
    run('quote');
    run('media-0');
    expect(actions.onMentionPress).toHaveBeenCalledWith('carol');
    expect(actions.onHashtagPress).toHaveBeenCalledWith('dash');
    expect(actions.onLinkPress).toHaveBeenCalledWith('https://dash.org');
    expect(actions.onQuotePress).toHaveBeenCalled();
    expect(actions.onMediaPress).toHaveBeenCalledWith(0);
  });

  it('keeps a covered quote’s text out of its label', () => {
    render(<PostCard post={{ ...POSTS.quote, id: 'quote-nsfw-label' }} quoteNsfwGated />);
    expect(screen.getByTestId('quote-embed').props.accessibilityLabel).toBe(
      'Quote: Carol, NSFW post, hidden',
    );
  });

  it('labels video and GIF thumbnails, and never loads a video URL as an image', () => {
    const post = fixturePost({
      id: 'video-gif',
      media: [
        { type: 'video', url: 'https://x.org/v.mp4' },
        { type: 'gif', url: 'https://x.org/a.gif', alt: 'dance' },
      ],
    });
    render(<PostCard post={post} />);
    expect(screen.getByLabelText('Video')).toBeTruthy();
    expect(screen.getByLabelText('GIF: dance')).toBeTruthy();
    expect(screen.getByText('GIF')).toBeTruthy();
  });

  it('never hands out an unsafe link-preview target', () => {
    const onLinkPreviewPress = jest.fn();
    render(
      <PostCard
        post={POSTS.linkPreview}
        linkPreview={{ ...SAMPLE_PREVIEW, url: 'javascript:alert(1)' }}
        actions={{ onLinkPreviewPress }}
      />,
    );
    fireEvent.press(screen.getByTestId('link-preview'));
    expect(onLinkPreviewPress).not.toHaveBeenCalled();
  });
});

describe('stubs', () => {
  it.each([
    ['removed', 'post', "This post was removed by the contract's moderators."],
    ['deleted', 'reply', 'This reply was deleted by its author.'],
    ['failed', 'post', 'This post could not be loaded. Try again later.'],
    ['unavailable', 'reply', 'This reply is unavailable.'],
    ['blocked', 'reply', 'Reply from an account you blocked'],
  ] as const)('%s %s reads "%s"', (state, kind, text) => {
    expect(stubText(state, kind)).toBe(text);
  });

  it('is one static element with the reason', () => {
    render(<PostStub state="removed" reason="Spam" />);
    expect(
      screen.getByLabelText("This post was removed by the contract's moderators. Reason: Spam"),
    ).toBeTruthy();
  });
});

describe('helpers', () => {
  it('clamps a single image between 16:9 and 4:5', () => {
    expect(singleAspectRatio({})).toBeCloseTo(16 / 9);
    expect(singleAspectRatio({ width: 3000, height: 1000 })).toBeCloseTo(16 / 9);
    expect(singleAspectRatio({ width: 1000, height: 3000 })).toBeCloseTo(4 / 5);
    expect(singleAspectRatio({ width: 1000, height: 1000 })).toBe(1);
  });

  it('labels poll ends and shares', () => {
    const now = Date.UTC(2026, 9, 1);
    expect(pollEndLabel(null, now)).toBe('No end date');
    expect(pollEndLabel(new Date(now - 1), now)).toBe('Ended');
    expect(pollEndLabel(new Date(now + 30 * 60_000), now)).toBe('Ends in 30m');
    expect(pollEndLabel(new Date(now + 5 * 3_600_000), now)).toBe('Ends in 5h');
    expect(pollPercents({ ...SAMPLE_POLL, totalVotes: 0 })).toEqual([0, 0, 0]);
  });

  it('reads a host without URL.hostname', () => {
    expect(displayHost('https://www.dash.org/platform/')).toBe('dash.org');
    expect(displayHost('https://user@sub.example.com:8080/x')).toBe('sub.example.com');
  });
});
