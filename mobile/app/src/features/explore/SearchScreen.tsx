import type { PostDTO, TagDTO, UserSummaryDTO } from '@engine/api';
import { FlashList } from '@shopify/flash-list';
import type { UseQueryResult } from '@tanstack/react-query';
import { router, Stack } from 'expo-router';
import { useRef, useState, type ReactElement } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { ArrowLeftIcon, ClockIcon, HashtagIcon, MagnifyingGlassIcon, UserIcon, XMarkIcon } from 'react-native-heroicons/outline';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { openHashtag, openUser } from '~/features/post/post-navigation';
import { PostItem } from '~/features/post/PostItem';
import { cn } from '~/lib-allowlist';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { IconButton } from '~/ui/IconButton';
import { Screen } from '~/ui/Screen';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { hitSlopFor, tw, useColors } from '~/ui/tokens';
import type { TextResetHandle } from '~/ui/native-text';

import { FollowableUserRow } from './FollowableUserRow';
import { recentKey, useRecentSearches, type RecentSearch } from './recent-searches';
import { SearchField } from './SearchField';
import { OfflineBanner, searchFailedMessage, searchFailedTitle, SectionHeader, useOffline } from './states';
import { TagRow } from './TagRow';
import { tagDisplay } from './tags';
import {
  SEARCH_DEBOUNCE_MS,
  SEARCH_TITLES,
  useDebounced,
  useSearch,
  type SearchKind,
} from './use-search';

/** PRD EXPL-05: each group shows up to 3 rows, then "See all". */
const PREVIEW = 3;

type Row =
  | { type: 'section'; key: string; kind: SearchKind; more: boolean }
  | { type: 'user'; key: string; user: UserSummaryDTO }
  | { type: 'tag'; key: string; tag: TagDTO }
  | { type: 'post'; key: string; post: PostDTO }
  | { type: 'hint'; key: string; text: string }
  | { type: 'failed'; key: string; kind: SearchKind; retry: () => void }
  | { type: 'searching'; key: string }
  | { type: 'recentHeader'; key: string }
  | { type: 'recent'; key: string; entry: RecentSearch };

function recentLabel(entry: RecentSearch): string {
  switch (entry.kind) {
    case 'query':
      return entry.q;
    case 'user':
      return entry.name;
    case 'tag':
      return tagDisplay(entry.tag);
  }
}

const RECENT_ICON = { query: ClockIcon, user: UserIcon, tag: HashtagIcon } as const;

function RecentRow({
  entry,
  onPress,
  onRemove,
}: {
  entry: RecentSearch;
  onPress: () => void;
  onRemove: () => void;
}) {
  const c = useColors();
  const label = recentLabel(entry);
  const Icon = RECENT_ICON[entry.kind];
  return (
    <View className="min-h-12 flex-row items-center pr-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={entry.kind === 'user' && entry.username ? `${label}, @${entry.username}` : label}
        onPress={onPress}
        testID={`recent-${label}`}
        className={cn('min-h-12 flex-1 flex-row items-center gap-3 px-4 py-2', tw.pressed)}
      >
        <Icon size={20} color={c.textSecondary} />
        <View className="flex-1">
          <Text variant="body" numberOfLines={1}>
            {label}
          </Text>
          {entry.kind === 'user' && entry.username ? (
            <Text variant="subhead" tone="secondary" numberOfLines={1}>
              @{entry.username}
            </Text>
          ) : null}
        </View>
      </Pressable>
      <IconButton
        icon={XMarkIcon}
        iconSize={18}
        accessibilityLabel={`Remove ${label}`}
        onPress={onRemove}
        testID={`recent-remove-${label}`}
      />
    </View>
  );
}

/** The section's state as rows: its first results, its failure, or nothing yet. */
function sectionRows<T>(
  kind: SearchKind,
  query: UseQueryResult<T[]>,
  toRow: (item: T) => Row,
  enabled: boolean,
): Row[] {
  if (!enabled) return [];
  if (query.isError) {
    return [
      { type: 'section', key: `section:${kind}`, kind, more: false },
      {
        type: 'failed',
        key: `failed:${kind}`,
        kind,
        retry: () => {
          query.refetch().catch(() => undefined);
        },
      },
    ];
  }
  const items = query.data ?? [];
  if (items.length === 0) return [];
  return [
    { type: 'section', key: `section:${kind}`, kind, more: items.length > PREVIEW },
    ...items.slice(0, PREVIEW).map(toRow),
  ];
}

export interface SearchScreenProps {
  initialQuery?: string;
}

/**
 * Search (UX_SPEC §4.16, PRD EXPL-05, EXPL-08): recent searches while the
 * field is empty, then People, Hashtags and Recent posts as the query
 * settles, three of each with "See all".
 */
export function SearchScreen({ initialQuery = '' }: SearchScreenProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const offline = useOffline();
  const recent = useRecentSearches();
  const [text, setText] = useState(initialQuery);
  // Submitting (the return key) searches at once; typing waits for a pause.
  const [submitted, setSubmitted] = useState<string | null>(initialQuery || null);
  const debounced = useDebounced(text, SEARCH_DEBOUNCE_MS);
  const settled = submitted !== null && submitted === text ? submitted : debounced;
  const { q, people, hashtags, posts, enabled } = useSearch(text.trim() ? settled : '');

  const field = useRef<TextResetHandle>(null);
  const search = (query: string) => {
    // A recent search tapped: put in as such, never taken for a late render of typing.
    field.current?.reset(query);
    setText(query);
    setSubmitted(query);
  };
  const submit = () => {
    const query = text.trim();
    if (!query) return;
    setSubmitted(text);
    recent.add({ kind: 'query', q: query });
  };
  const openRecent = (entry: RecentSearch) => {
    recent.add(entry);
    if (entry.kind === 'query') search(entry.q);
    else if (entry.kind === 'user') openUser(entry.id);
    else openHashtag(entry.tag);
  };
  const seeAll = (kind: SearchKind) => {
    recent.add({ kind: 'query', q });
    router.push({ pathname: '/explore/search/[kind]', params: { kind, q } });
  };

  const rows: Row[] = [];
  let body: ReactElement | null = null;

  if (!text.trim()) {
    if (recent.entries.length > 0) {
      rows.push({ type: 'recentHeader', key: 'recent-header' });
      for (const entry of recent.entries) rows.push({ type: 'recent', key: recentKey(entry), entry });
    } else {
      body = (
        <EmptyState
          title="Search Yappr"
          description="Find people, hashtags and recent posts."
          icon={MagnifyingGlassIcon}
          testID="search-idle"
        />
      );
    }
  } else if (q) {
    if (!enabled.people) {
      rows.push({ type: 'section', key: 'section:people', kind: 'people', more: false });
      rows.push({ type: 'hint', key: 'hint:people', text: 'Type at least 3 characters to search for people' });
    }
    rows.push(
      ...sectionRows('people', people, (user) => ({ type: 'user', key: `user:${user.id}`, user }), enabled.people),
      ...sectionRows('hashtags', hashtags, (tag) => ({ type: 'tag', key: `tag:${tag.tag}`, tag }), enabled.hashtags),
      ...sectionRows('posts', posts, (post) => ({ type: 'post', key: `post:${post.id}`, post }), enabled.posts),
    );
    const running = [enabled.people && people, enabled.hashtags && hashtags, enabled.posts && posts].filter(
      (query) => query !== false,
    );
    const searching = running.some((query) => query.isPending);
    const results = rows.some((row) => row.type === 'user' || row.type === 'tag' || row.type === 'post');
    if (searching) rows.push({ type: 'searching', key: 'searching' });
    else if (running.every((query) => query.isError)) {
      body = (
        <ErrorState
          title={searchFailedTitle()}
          message={searchFailedMessage(running[0]?.error, offline)}
          onRetry={() => running.forEach((query) => query.refetch().catch(() => undefined))}
          retrying={running.some((query) => query.isRetrying)}
          testID="search-error"
        />
      );
    } else if (!results && !rows.some((row) => row.type === 'failed')) {
      body = (
        <EmptyState
          title={`No results for "${q}"`}
          description="Try searching for something else"
          icon={MagnifyingGlassIcon}
          testID="search-no-results"
        />
      );
    }
  } else {
    rows.push({ type: 'searching', key: 'searching' });
  }

  const renderRow = (row: Row): ReactElement => {
    switch (row.type) {
      case 'recentHeader':
        return (
          <SectionHeader title="Recent">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear recent searches"
              hitSlop={hitSlopFor(20)}
              onPress={recent.clear}
              testID="recent-clear"
            >
              <Text variant="subheadStrong" tone="link">
                Clear
              </Text>
            </Pressable>
          </SectionHeader>
        );
      case 'recent':
        return (
          <RecentRow entry={row.entry} onPress={() => openRecent(row.entry)} onRemove={() => recent.remove(row.entry)} />
        );
      case 'section':
        return (
          <SectionHeader title={SEARCH_TITLES[row.kind]} testID={`search-section-${row.kind}`}>
            {row.more ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`See all ${SEARCH_TITLES[row.kind].toLowerCase()}`}
                hitSlop={hitSlopFor(20)}
                onPress={() => seeAll(row.kind)}
                testID={`search-see-all-${row.kind}`}
              >
                <Text variant="subheadStrong" tone="link">
                  See all
                </Text>
              </Pressable>
            ) : null}
          </SectionHeader>
        );
      case 'user':
        return (
          <FollowableUserRow
            user={row.user}
            followable={false}
            onOpen={(user) =>
              recent.add({ kind: 'user', id: user.id, name: user.displayName, username: user.username })
            }
            testID={`search-user-${row.user.username ?? row.user.id}`}
          />
        );
      case 'tag':
        return (
          <TagRow
            tag={row.tag}
            onPress={(tag) => {
              recent.add({ kind: 'tag', tag: tag.tag });
              openHashtag(tag.tag);
            }}
            testID={`search-tag-${row.tag.tag}`}
          />
        );
      case 'post':
        return (
          <View className={cn('border-b', tw.border)}>
            <PostItem post={row.post} variant="compact" />
          </View>
        );
      case 'hint':
        return (
          <Text variant="subhead" tone="secondary" className="px-4 py-3" testID="search-hint">
            {row.text}
          </Text>
        );
      case 'failed':
        return (
          <View className="flex-row items-center justify-between gap-3 px-4 py-3">
            <Text variant="subhead" tone="secondary" className="flex-1">
              {searchFailedTitle(SEARCH_TITLES[row.kind].toLowerCase())}.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Try searching ${SEARCH_TITLES[row.kind].toLowerCase()} again`}
              hitSlop={hitSlopFor(20)}
              onPress={row.retry}
              testID={`search-retry-${row.kind}`}
            >
              <Text variant="subheadStrong" tone="link">
                Try again
              </Text>
            </Pressable>
          </View>
        );
      case 'searching':
        return (
          <View className="flex-row items-center justify-center gap-3 p-6" testID="search-searching">
            <Spinner size="sm" />
            <Text variant="subhead" tone="secondary">
              Searching…
            </Text>
          </View>
        );
    }
  };

  const ios = Platform.OS === 'ios';
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Search', headerShown: false, animation: 'fade' }} />
      <View
        style={{ paddingTop: insets.top + 8 }}
        className={cn('flex-row items-center gap-2 border-b pb-2', ios ? 'pl-4 pr-2' : 'px-2', tw.border, tw.bg)}
      >
        {ios ? null : (
          <IconButton
            icon={ArrowLeftIcon}
            accessibilityLabel="Back"
            color={c.textPrimary}
            onPress={() => router.back()}
            testID="search-back"
          />
        )}
        <SearchField
          ref={field}
          value={text}
          onChangeText={(next) => {
            setText(next);
            setSubmitted(null);
          }}
          onSubmitEditing={submit}
          autoFocus={!initialQuery}
        />
        {ios ? (
          <Pressable
            accessibilityRole="button"
            hitSlop={hitSlopFor(20)}
            onPress={() => router.back()}
            testID="search-cancel"
            className="min-h-11 justify-center px-2"
          >
            <Text variant="body" tone="link">
              Cancel
            </Text>
          </Pressable>
        ) : null}
      </View>
      {offline ? <OfflineBanner /> : null}
      {body ?? (
        <FlashList
          data={rows}
          keyExtractor={(row) => row.key}
          getItemType={(row) => row.type}
          renderItem={({ item }) => renderRow(item)}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ paddingBottom: 24 }}
          testID="search-results"
        />
      )}
    </Screen>
  );
}
