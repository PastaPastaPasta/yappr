import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import {
  BellIcon,
  BookmarkIcon,
  EllipsisHorizontalIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
} from 'react-native-heroicons/outline';

import { formatNumber, formatTimeCompact } from '~/lib-allowlist';
import { useAppearance, type ThemePreference } from '~/state/appearance';

import { Avatar } from '../Avatar';
import { CountBadge, Tag, UnreadDot } from '../Badge';
import { Button } from '../Button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../Card';
import { ConfirmDialog, confirmAlert } from '../Dialog';
import { EmptyState, ErrorState } from '../EmptyState';
import { IconButton } from '../IconButton';
import { LoadingState } from '../LoadingState';
import { NetworkChip } from '../NetworkChip';
import { PostCard } from '../post/PostCard';
import { PostStub } from '../post/PostStub';
import { FIXTURE_AVATARS } from '../post/fixture-avatars';
import { AUTHORS, POSTS, SAMPLE_POLL, SAMPLE_PREVIEW, VIEWER_ID } from '../post/fixtures';
import { RadioGroup } from '../RadioGroup';
import { RichText } from '../rich-text/RichText';
import { Sheet } from '../Sheet';
import { PostSkeleton, RowSkeleton, Skeleton } from '../Skeleton';
import { Spinner } from '../Spinner';
import { Switch, SwitchRow } from '../Switch';
import { FilterChips, SegmentedControl, TopTabs } from '../Tabs';
import { Text } from '../Text';
import { TextField } from '../TextField';
import { toast } from '../toast';
import { tw } from '../tokens';
import { UserRow } from '../UserRow';
import { WriteStatus } from '../WriteStatus';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className={`gap-3 border-b px-4 py-4 ${tw.border}`}>
      <Text variant="captionStrong" tone="secondary" className="uppercase tracking-wider">
        {title}
      </Text>
      {children}
    </View>
  );
}

const Row = ({ children }: { children: ReactNode }) => (
  <View className="flex-row flex-wrap items-center gap-2">{children}</View>
);

/** Full-bleed: post cards bring their own gutter. */
const Bleed = ({ title, children }: { title: string; children: ReactNode }) => (
  <View>
    <Text variant="captionStrong" tone="secondary" className="px-4 pb-1 pt-4 uppercase tracking-wider">
      {title}
    </Text>
    {children}
  </View>
);

// Literal class names: Tailwind only generates classes it can find in source.
const YAPPR_RAMP = [
  'bg-yappr-50',
  'bg-yappr-100',
  'bg-yappr-200',
  'bg-yappr-300',
  'bg-yappr-400',
  'bg-yappr-500',
  'bg-yappr-600',
  'bg-yappr-700',
  'bg-yappr-800',
  'bg-yappr-900',
  'bg-yappr-950',
];
const THEMES: ThemePreference[] = ['system', 'light', 'dark'];
/** 30 s, 5 m, 3 h, 2 d and 40 d before the gallery loaded. */
const TIME_SAMPLES = [30_000, 300_000, 10_800_000, 172_800_000, 3_456_000_000].map(
  (ms) => new Date(Date.now() - ms),
);
const noop = () => undefined;

function TokensSection() {
  const { theme, setTheme } = useAppearance();
  return (
    <>
      <Section title="Theme (Settings > Appearance plumbing)">
        <SegmentedControl
          options={THEMES.map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1) }))}
          value={theme}
          onChange={setTheme}
          testID="gallery-theme"
        />
      </Section>
      <Section title="yappr-50 … yappr-950 · neutral-750 / 850 / 900">
        <View className="flex-row overflow-hidden rounded-lg">
          {YAPPR_RAMP.map((c) => (
            <View key={c} className={`h-8 flex-1 ${c}`} />
          ))}
        </View>
        <View className="flex-row gap-2">
          <View className="h-8 flex-1 rounded-lg bg-neutral-750" />
          <View className="h-8 flex-1 rounded-lg bg-neutral-850" />
          <View className="h-8 flex-1 rounded-lg bg-neutral-900" />
        </View>
      </Section>
      <Section title="Type scale">
        <Text variant="titleLarge">Title large 24</Text>
        <Text variant="title">Title 20</Text>
        <Text variant="headline">Headline 18</Text>
        <Text variant="body">Body 16 — post text</Text>
        <Text variant="subhead" tone="secondary">
          Subhead 14 · secondary
        </Text>
        <Text variant="caption" tone="secondary">
          Caption 12
        </Text>
        <Row>
          <Text variant="subhead" tone="link">
            link
          </Text>
          <Text variant="subhead" tone="like">
            like
          </Text>
          <Text variant="subhead" tone="repost">
            repost
          </Text>
          <Text variant="subhead" tone="destructive">
            destructive
          </Text>
          <Text variant="subhead" tone="warning">
            warning
          </Text>
          <Text variant="subhead" tone="private">
            private
          </Text>
        </Row>
      </Section>
    </>
  );
}

function ButtonsSection() {
  const [liked, setLiked] = useState(false);
  return (
    <>
      <Section title="Button variants (md)">
        <Row>
          <Button label="Primary" />
          <Button label="Secondary" variant="secondary" />
          <Button label="Outline" variant="outline" />
        </Row>
        <Row>
          <Button label="Ghost" variant="ghost" />
          <Button label="Delete" variant="destructive" icon={TrashIcon} />
          <Button label="Link" variant="link" />
        </Row>
      </Section>
      <Section title="Sizes and states">
        <Row>
          <Button label="Small" size="sm" />
          <Button label="Medium" />
          <Button label="Large" size="lg" icon={PencilSquareIcon} />
        </Row>
        <Row>
          <Button label="Loading" loading />
          <Button label="Disabled" disabled />
          <Button label="Following" variant="outline" size="sm" />
        </Row>
        <Button label="Block button" size="block" />
      </Section>
      <Section title="IconButton">
        <Row>
          <IconButton icon={EllipsisHorizontalIcon} accessibilityLabel="Post options" />
          <IconButton icon={PlusIcon} variant="primary" accessibilityLabel="Add" />
          <IconButton icon={TrashIcon} variant="danger" accessibilityLabel="Delete" />
          <IconButton icon={BellIcon} disabled accessibilityLabel="Disabled" />
          <IconButton
            icon={BookmarkIcon}
            accessibilityLabel={liked ? 'Remove bookmark' : 'Bookmark'}
            accessibilityState={{ selected: liked }}
            variant={liked ? 'primary' : 'default'}
            onPress={() => setLiked((v) => !v)}
          />
        </Row>
      </Section>
      <Section title="Card">
        <Card>
          <CardHeader>
            <CardTitle>Card title</CardTitle>
            <CardDescription>components/ui/card.tsx, class for class.</CardDescription>
          </CardHeader>
          <CardContent>
            <Text variant="subhead">Content goes here.</Text>
          </CardContent>
          <CardFooter>
            <Button label="Action" size="sm" />
          </CardFooter>
        </Card>
      </Section>
    </>
  );
}

function InputsSection() {
  const [text, setText] = useState('');
  const [secret, setSecret] = useState('cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy');
  const [bio, setBio] = useState('Builder of things.');
  const [on, setOn] = useState(true);
  const [mode, setMode] = useState<'blur' | 'show' | 'hide'>('blur');
  return (
    <>
      <Section title="Text fields">
        <TextField label="Display name" placeholder="Your name" value={text} onChangeText={setText} />
        <TextField
          label="Username"
          value="al"
          error="Usernames are at least 3 characters"
          onChangeText={noop}
        />
        <TextField label="Private key" secure value={secret} onChangeText={setSecret} />
        <TextField label="Bio" multiline value={bio} onChangeText={setBio} maxLength={30} />
      </Section>
      <Section title="Switches">
        <Row>
          <Switch value={on} onValueChange={setOn} accessibilityLabel="Sample switch" />
          <Switch value={false} disabled accessibilityLabel="Disabled switch" />
        </Row>
        <View className={`-mx-4 border-y ${tw.border}`}>
          <SwitchRow
            label="Link previews"
            description="Show a card for the first link in a post."
            value={on}
            onValueChange={setOn}
          />
        </View>
      </Section>
      <Section title="RadioGroup (NSFW mode)">
        <View className={`-mx-4 border-y ${tw.border}`}>
          <RadioGroup
            accessibilityLabel="Sensitive content"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'blur', title: 'Cover', description: 'Hide behind a cover with a Show button.' },
              { value: 'show', title: 'Show', description: 'Show sensitive posts like any other.' },
              { value: 'hide', title: 'Hide', description: "Don't show sensitive posts at all." },
            ]}
          />
        </View>
      </Section>
    </>
  );
}

function NavigationSection() {
  const [tab, setTab] = useState<'for-you' | 'following'>('for-you');
  const [sort, setSort] = useState<'recent' | 'top'>('recent');
  const [filter, setFilter] = useState<'all' | 'mentions' | 'likes' | 'follows'>('all');
  return (
    <>
      <Section title="Top tabs">
        <View className="-mx-4">
          <TopTabs
            options={[
              { value: 'for-you', label: 'For You' },
              { value: 'following', label: 'Following' },
            ]}
            value={tab}
            onChange={setTab}
          />
        </View>
      </Section>
      <Section title="Segmented control (native on iOS, Material on Android)">
        <SegmentedControl
          options={[
            { value: 'recent', label: 'Recent' },
            { value: 'top', label: 'Top' },
          ]}
          value={sort}
          onChange={setSort}
        />
      </Section>
      <Section title="Filter chips">
        <View className="-mx-4">
          <FilterChips
            options={[
              { value: 'all', label: 'All', count: 3 },
              { value: 'mentions', label: 'Mentions' },
              { value: 'likes', label: 'Likes', count: 120 },
              { value: 'follows', label: 'Follows' },
            ]}
            value={filter}
            onChange={setFilter}
          />
        </View>
      </Section>
      <Section title="Badges, tags, network chip">
        <Row>
          <CountBadge count={3} />
          <CountBadge count={42} />
          <CountBadge count={120} />
          <UnreadDot />
          <Tag label="Follows you" />
          <Tag label="Owner" />
        </Row>
        <Row>
          <NetworkChip network="devnet" state="ready" onPress={noop} />
          <NetworkChip network="testnet" state="booting" onPress={noop} />
          <NetworkChip network="devnet" state="unavailable" onPress={noop} />
        </Row>
      </Section>
    </>
  );
}

function FeedbackSection() {
  const [sheet, setSheet] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [deleting, setDeleting] = useState(false);
  return (
    <>
      <Section title="Toasts (top-center)">
        <Row>
          <Button
            label="Success"
            size="sm"
            variant="secondary"
            onPress={() => toast.success('Post created successfully!')}
          />
          <Button
            label="Error"
            size="sm"
            variant="secondary"
            onPress={() =>
              toast.error("Couldn't post. Check your connection.", {
                action: { label: 'Retry', onPress: noop },
              })
            }
          />
          <Button
            label="Info"
            size="sm"
            variant="secondary"
            onPress={() => toast('Link copied to clipboard')}
          />
        </Row>
      </Section>
      <Section title="Sheet and dialogs">
        <Row>
          <Button label="Open sheet" size="sm" onPress={() => setSheet(true)} />
          <Button label="Confirm dialog" size="sm" variant="outline" onPress={() => setDialog(true)} />
          <Button
            label="Native confirm"
            size="sm"
            variant="outline"
            onPress={() => {
              confirmAlert({
                title: 'Delete post?',
                message: "This can't be undone.",
                confirmText: 'Delete',
                destructive: true,
              })
                .then((ok) => toast(ok ? 'Confirmed' : 'Cancelled'))
                .catch(noop);
            }}
          />
        </Row>
      </Section>
      <Section title="Write status">
        <WriteStatus status={{ state: 'posting' }} />
        <WriteStatus status={{ state: 'threadProgress', index: 2, total: 5 }} />
        <WriteStatus status={{ state: 'unconfirmed' }} onCheckAgain={noop} />
        <WriteStatus status={{ state: 'unconfirmed', canEdit: true }} onCheckAgain={noop} onEdit={noop} />
        <WriteStatus status={{ state: 'failed' }} onRetry={noop} onEdit={noop} />
        <WriteStatus status={{ state: 'partial', posted: 2, total: 5 }} onRetryRest={noop} />
      </Section>
      <Section title="Spinner, loading, skeletons">
        <Row>
          <Spinner size="sm" />
          <Spinner size="md" />
          <Skeleton width={96} />
          <Skeleton circle height={40} />
        </Row>
        <LoadingState loading loadingText="Loading posts…">
          {null}
        </LoadingState>
      </Section>
      <View>
        <PostSkeleton />
        <RowSkeleton />
        <RowSkeleton withTime />
      </View>
      <Section title="Empty and error states">
        <EmptyState
          title="No bookmarks yet"
          description="Save posts for later by tapping the bookmark on any post."
          icon={BookmarkIcon}
        />
        <ErrorState message="Couldn't connect to Dash Platform." onRetry={noop} />
      </Section>

      <Sheet open={sheet} onClose={() => setSheet(false)} title="Network">
        <NetworkChip network="devnet" state="ready" />
        <Text variant="subhead" tone="secondary">
          Devnet data may be reset at any time. Your identity and posts here are for testing.
        </Text>
        <Button label="Done" size="block" onPress={() => setSheet(false)} />
      </Sheet>
      <ConfirmDialog
        isOpen={dialog}
        onClose={() => setDialog(false)}
        onConfirm={() => {
          setDeleting(true);
          setTimeout(() => {
            setDeleting(false);
            setDialog(false);
            toast.success('Post deleted');
          }, 1200);
        }}
        title="Delete post?"
        message="This can't be undone and it will be removed from your profile."
        confirmText="Delete"
        isLoading={deleting}
      />
    </>
  );
}

function PeopleSection() {
  const [following, setFollowing] = useState(false);
  return (
    <>
      <Section title="Avatar (DiceBear SVG, image URL, fallback, empty)">
        <Row>
          <Avatar avatar={AUTHORS.alice.avatar} identityId={AUTHORS.alice.id} size="xs" />
          <Avatar avatar={AUTHORS.bob.avatar} identityId={AUTHORS.bob.id} size="sm" />
          <Avatar avatar={AUTHORS.carol.avatar} identityId={AUTHORS.carol.id} size="md" />
          <Avatar avatar={{ uri: 'https://picsum.photos/id/64/200/200', dicebear: null }} size="lg" />
          <Avatar
            uri="https://invalid.example/missing.png"
            fallback={FIXTURE_AVATARS.nameless.uri}
            size="xl"
          />
          <Avatar size="lg" />
        </Row>
        <Avatar
          avatar={AUTHORS.alice.avatar}
          identityId={AUTHORS.alice.id}
          size="profile"
          name="Alice"
          onPress={noop}
        />
      </Section>
      <View className={`border-b ${tw.border}`}>
        <UserRow
          user={{
            ...AUTHORS.bob,
            bio: 'Builder of things. Two-line bio clamp keeps rows tidy even when the bio runs long.',
          }}
          followsYou
          following={following}
          onFollowPress={() => setFollowing((f) => !f)}
          onPress={noop}
        />
        <UserRow user={AUTHORS.carol} following onFollowPress={noop} onPress={noop} />
        <UserRow user={AUTHORS.nameless} followLoading onFollowPress={noop} onPress={noop} />
        <UserRow user={AUTHORS.alice} isSelf onPress={noop} />
      </View>
      <Section title="RichText">
        <RichText
          text={
            'Hey @bob.dash, check #DashPlatform and $dash at https://yap.pr/post?id=abc (it works).\n**Bold @mention** and `code` — 👩🏽‍💻 emoji safe.'
          }
          onMentionPress={(u) => toast(`@${u}`)}
          onHashtagPress={(t) => toast(`#${t}`)}
          onCashtagPress={(t) => toast(t)}
          onLinkPress={(u) => toast(u)}
        />
        <RichText text="שלום עולם! #עברית is not a tag, #hebrew is." />
      </Section>
      <Section title="Relative time and compact numbers">
        <Row>
          {TIME_SAMPLES.map((date) => (
            <Tag key={date.getTime()} label={formatTimeCompact(date)} />
          ))}
        </Row>
        <Row>
          {[0, 7, 999, 1000, 1500, 48_200, 1_250_000].map((n) => (
            <Tag key={n} label={formatNumber(n)} />
          ))}
        </Row>
      </Section>
    </>
  );
}

function PostCardsA() {
  return (
    <>
      <Bleed title="Web parity (testnet post 4NeHEz…)">
        <PostCard post={POSTS.webParity} actions={{ onPress: noop, onMore: noop }} />
      </Bleed>
      <Bleed title="Feed card">
        <PostCard post={POSTS.basic} viewerId={VIEWER_ID} actions={{ onPress: noop, onMore: noop }} />
      </Bleed>
      <Bleed title="Active: liked, reposted, bookmarked">
        <PostCard post={POSTS.liked} actions={{ onMore: noop }} />
      </Bleed>
      <Bleed title="Repost banner">
        <PostCard post={POSTS.repost} actions={{ onMore: noop }} />
      </Bleed>
      <Bleed title="Reply, nameless author, resolving author">
        <PostCard post={POSTS.reply} replyingTo="bob" actions={{ onMore: noop }} />
        <PostCard
          post={POSTS.nameless}
          actions={{ onMore: noop, onCopyId: () => toast('Identity ID copied') }}
        />
        <PostCard post={POSTS.basic} authorPending actions={{ onMore: noop }} />
      </Bleed>
      <Bleed title="Markdown, RTL, emoji-only, long (clamped)">
        <PostCard post={POSTS.markdown} actions={{ onMore: noop }} />
        <PostCard post={POSTS.emoji} actions={{ onMore: noop }} />
        <PostCard post={POSTS.long} actions={{ onPress: noop, onMore: noop }} />
      </Bleed>
    </>
  );
}

function PostCardsB() {
  return (
    <>
      <Bleed title="Quote embed, removed quote, loading quote">
        <PostCard post={POSTS.quote} actions={{ onMore: noop }} />
        <PostCard post={POSTS.quoteRemoved} actions={{ onMore: noop }} />
        <PostCard
          post={{ ...POSTS.quoteRemoved, id: 'post-quote-loading', quotedRemoved: false }}
          quoteLoading
        />
      </Bleed>
      <Bleed title="Media grid: 1, 2, 3 and 4 items">
        <PostCard post={POSTS.oneImage} actions={{ onMore: noop }} />
        <PostCard post={POSTS.twoImages} actions={{ onMore: noop }} />
        <PostCard post={POSTS.threeImages} actions={{ onMore: noop }} />
        <PostCard post={POSTS.fourImages} actions={{ onMore: noop }} />
      </Bleed>
    </>
  );
}

function PostCardsC() {
  const [revealed, setRevealed] = useState(false);
  return (
    <>
      <Bleed title="Link preview, YouTube, loading preview">
        <PostCard post={POSTS.linkPreview} linkPreview={SAMPLE_PREVIEW} actions={{ onMore: noop }} />
        <PostCard
          post={POSTS.youtube}
          linkPreview={{
            url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
            title: 'A video',
            youtubeVideoId: 'jNQXAC9IVRw',
          }}
        />
        <PostCard post={{ ...POSTS.linkPreview, id: 'post-link-loading' }} linkPreview="loading" />
      </Bleed>
      <Bleed title="Poll: results, loading, unavailable">
        <PostCard post={POSTS.poll} poll={SAMPLE_POLL} actions={{ onMore: noop }} />
        <PostCard post={{ ...POSTS.poll, id: 'post-poll-loading' }} poll="loading" variant="compact" />
        <PostCard post={{ ...POSTS.poll, id: 'post-poll-error' }} poll="error" variant="compact" />
      </Bleed>
      <Bleed title="NSFW cover, media gate, private">
        <PostCard post={POSTS.nsfw} actions={{ onMore: noop }} />
        <PostCard
          post={POSTS.mediaGated}
          mediaGated={!revealed}
          onRevealMedia={() => setRevealed(true)}
          actions={{ onMore: noop }}
        />
        <PostCard post={POSTS.private} actions={{ onMore: noop, onOpenPrivate: noop }} />
      </Bleed>
      <Bleed title="Stubs: tombstone, removed, deleted, failed, unavailable, blocked">
        <PostCard post={POSTS.tombstone} />
        <PostStub state="removed" reason="Spam" />
        <PostStub state="removed" kind="reply" kept="#dash · posted Sep 30" />
        <PostStub state="deleted" />
        <PostStub state="failed" kind="reply" />
        <PostStub state="unavailable" />
        <PostStub state="blocked" kind="reply" />
      </Bleed>
      <Bleed title="Optimistic: posting, not confirmed, can't confirm, failed">
        <PostCard
          post={POSTS.optimistic}
          variant="optimistic"
          writeStatus={{ status: { state: 'posting' } }}
        />
        <PostCard
          post={{ ...POSTS.optimistic, id: 'opt-2' }}
          variant="optimistic"
          writeStatus={{ status: { state: 'unconfirmed' }, onCheckAgain: noop }}
        />
        <PostCard
          post={{ ...POSTS.optimistic, id: 'opt-3' }}
          variant="optimistic"
          writeStatus={{ status: { state: 'failed' }, onRetry: noop, onEdit: noop }}
        />
      </Bleed>
      <Bleed title="Detail and compact">
        <PostCard post={POSTS.liked} variant="detail" actions={{ onMore: noop }} />
        <PostCard post={POSTS.basic} variant="compact" />
      </Bleed>
    </>
  );
}

/** The gallery's sections, addressable as `/__gallery?section=<id>` for screenshots. */
export const GALLERY_SECTIONS = [
  { id: 'tokens', label: 'Tokens', Component: TokensSection },
  { id: 'buttons', label: 'Buttons', Component: ButtonsSection },
  { id: 'inputs', label: 'Inputs', Component: InputsSection },
  { id: 'navigation', label: 'Tabs & chips', Component: NavigationSection },
  { id: 'feedback', label: 'Feedback', Component: FeedbackSection },
  { id: 'people', label: 'People & text', Component: PeopleSection },
  { id: 'posts', label: 'Posts', Component: PostCardsA },
  { id: 'embeds', label: 'Embeds & media', Component: PostCardsB },
  { id: 'states', label: 'Post states', Component: PostCardsC },
] as const;

export type GallerySectionId = (typeof GALLERY_SECTIONS)[number]['id'];
