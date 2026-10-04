import type { AuthorDTO, ProfileDTO, UserSummaryDTO } from '@engine/api';
import { keepPreviousData } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Pressable, ScrollView, TextInput, View, type LayoutChangeEvent } from 'react-native';
import { CheckCircleIcon, MagnifyingGlassIcon, XCircleIcon } from 'react-native-heroicons/solid';

import { queryKeys } from '~/data/keys';
import { useEngineInfiniteQuery, useEngineQuery } from '~/data/queries';
import { cn } from '~/lib-allowlist';
import { Avatar } from '~/ui/Avatar';
import { handleOf } from '~/ui/handle';
import { RowSkeleton } from '~/ui/Skeleton';
import { Text } from '~/ui/Text';
import { hitSlopFor, monoFont, tw, useColors } from '~/ui/tokens';

import { isIdentityIdText, isValidIdentityId } from './dm-model';

/** A person the picker offers. */
export type PickerUser = Pick<AuthorDTO, 'id' | 'username' | 'displayName' | 'avatar'>;

const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY = 3;
/** Follower suggestions before anything is typed (web `MAX_FOLLOWER_SUGGESTIONS`). */
const MAX_FOLLOWERS = 50;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function PickerRow({
  user,
  selected,
  multi,
  disabled,
  onPress,
}: {
  user: PickerUser;
  selected: boolean;
  multi: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole={multi ? 'checkbox' : 'button'}
      accessibilityLabel={`${user.displayName}, ${handleOf(user)}`}
      accessibilityState={multi ? { checked: selected, disabled } : { disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={`picker-user-${user.id}`}
      className={cn('min-h-16 flex-row items-center gap-3 px-4 py-2.5', tw.pressed, disabled && 'opacity-50')}
    >
      <Avatar avatar={user.avatar} identityId={user.id} size="md" />
      <View className="flex-1">
        <Text variant="bodyStrong" numberOfLines={1}>
          {user.displayName}
        </Text>
        <Text variant="subhead" tone="secondary" numberOfLines={1} style={user.username ? undefined : monoFont}>
          {handleOf(user)}
        </Text>
      </View>
      {multi ? (
        selected ? (
          <CheckCircleIcon size={24} color={c.accent} />
        ) : (
          <View className={cn('h-[22px] w-[22px] rounded-full border-2', tw.borderStrong)} />
        )
      ) : null}
    </Pressable>
  );
}

function Hint({ text, testID }: { text: string; testID?: string }) {
  return (
    <Text variant="subhead" tone="secondary" className="px-4 py-3" testID={testID}>
      {text}
    </Text>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <View accessible accessibilityLabel={label}>
      <RowSkeleton />
      <RowSkeleton />
      <Hint text={label} />
    </View>
  );
}

export interface UserPickerProps {
  viewerId: string;
  /** Multi-select (new group, add members): rows show a check circle. */
  multi?: boolean;
  selectedIds?: ReadonlySet<string>;
  /** People who can't be picked (already members): shown dimmed. */
  excludeIds?: ReadonlySet<string>;
  onPick: (user: PickerUser) => void;
  /** Shown under the search field (e.g. "New members can read messages sent after they join."). */
  note?: string;
  autoFocus?: boolean;
  initialQuery?: string;
  /**
   * The search field took focus, and again once the keyboard is up while it
   * has it (`usePickerReveal`).
   */
  onSearchFocus?: () => void;
}

/** Calls `reveal` as the field takes focus, and once more when the keyboard has come up while it has it. */
function useRevealOnFocus(reveal: (() => void) | undefined) {
  const focused = useRef(false);
  const latest = useRef(reveal);
  useEffect(() => {
    latest.current = reveal;
  }, [reveal]);
  const enabled = !!reveal;
  useEffect(() => {
    if (!enabled) return undefined;
    const subscription = Keyboard.addListener('keyboardDidShow', () => {
      if (focused.current) latest.current?.();
    });
    return () => subscription.remove();
  }, [enabled]);
  return {
    onFocus: () => {
      focused.current = true;
      latest.current?.();
    },
    onBlur: () => {
      focused.current = false;
    },
  };
}

/**
 * For a picker low in a screen's scroll view (Group info › Add members):
 * searching scrolls the picker's section to the top of the view, so its
 * results show between the field and the keyboard instead of under it
 * (NEW-ios-picker-keyboard). The section's picker is at least as tall as the
 * view, so there is always room to scroll that far; on iOS the view also
 * insets its content by the keyboard. Spread `scrollProps` on the scroll
 * view and `sectionProps` on the section that starts with the picker's
 * toggle, give the picker `minHeight`, and pass `reveal` as its
 * `onSearchFocus`.
 */
export function usePickerReveal() {
  const scroll = useRef<ScrollView>(null);
  const sectionY = useRef(0);
  const [minHeight, setMinHeight] = useState(0);
  const reveal = useCallback(() => scroll.current?.scrollTo({ y: sectionY.current, animated: true }), []);
  return {
    scrollProps: {
      ref: scroll,
      automaticallyAdjustKeyboardInsets: true,
      onLayout: (event: LayoutChangeEvent) => setMinHeight(event.nativeEvent.layout.height),
    },
    sectionProps: {
      onLayout: (event: LayoutChangeEvent) => {
        sectionY.current = event.nativeEvent.layout.y;
      },
    },
    minHeight,
    reveal,
  };
}

/**
 * The person picker (PRD DM-05, DM-06): "Search by username..." (3+
 * characters, or a pasted identity ID) and, before typing, the viewer's
 * followers. Renders plain rows: the screen around it scrolls.
 */
export function UserPicker({
  viewerId,
  multi = false,
  selectedIds,
  excludeIds,
  onPick,
  note,
  autoFocus = false,
  initialQuery = '',
  onSearchFocus,
}: UserPickerProps) {
  const c = useColors();
  const focusHandlers = useRevealOnFocus(onSearchFocus);
  const [query, setQuery] = useState(initialQuery);
  const text = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
  const typing = query.trim() !== text;
  const byId = isIdentityIdText(text);
  const validId = byId && isValidIdentityId(text);
  const searching = !byId && text.length >= MIN_QUERY;

  const followers = useEngineInfiniteQuery<UserSummaryDTO>(
    queryKeys.profile.followers(viewerId),
    (api, cursor) => api.graph.followers(viewerId, cursor),
    { enabled: text.length === 0 },
  );
  // The last results stay while the next search loads, so rows don't flash (or move under a tap).
  const search = useEngineQuery<UserSummaryDTO[]>(
    queryKeys.explore.search('users', text),
    (api) => api.explore.searchUsers(text),
    { enabled: searching, placeholderData: keepPreviousData },
  );
  const lookup = useEngineQuery<ProfileDTO | null>(queryKeys.profile.detail(text), (api) => api.profiles.get(text), {
    enabled: validId,
  });

  const rows = (users: readonly PickerUser[]) =>
    users.map((user) => (
      <PickerRow
        key={user.id}
        user={user}
        multi={multi}
        selected={selectedIds?.has(user.id) ?? false}
        disabled={excludeIds?.has(user.id) ?? false}
        onPress={() => onPick(user)}
      />
    ));

  const followerRows = useMemo(
    () => followers.items.filter((u) => u.id !== viewerId).slice(0, MAX_FOLLOWERS),
    [followers.items, viewerId],
  );

  let body;
  if (text.length === 0) {
    if (followers.isPending) body = <Loading label="Loading followers…" />;
    else if (followerRows.length === 0) body = <Hint text="No followers yet — search for a username above." />;
    else {
      body = (
        <>
          <Text variant="subheadStrong" tone="secondary" className="px-4 pb-1 pt-3" accessibilityRole="header">
            Your followers
          </Text>
          {rows(followerRows)}
        </>
      );
    }
  } else if (byId) {
    if (text === viewerId) body = <Hint text="You can't message yourself" testID="picker-self" />;
    // Looks like an id but is not one (it does not decode to 32 bytes): never blame the connection.
    else if (!validId) body = typing ? <Loading label="Searching…" /> : <Hint text="Invalid identity ID" testID="picker-invalid" />;
    else if (lookup.isPending || typing) body = <Loading label="Searching…" />;
    else if (lookup.isError) body = <Hint text="Couldn't look up this identity. Check your connection and try again." />;
    else if (!lookup.data) body = <Hint text="No user found with this identity ID" />;
    else body = rows([lookup.data]);
  } else if (!searching) {
    body = <Hint text="Type at least 3 characters to search, or paste a full identity ID" testID="picker-hint" />;
  } else if (search.isError && !search.data) {
    body = <Hint text="Search failed. Check your connection and try again." />;
  } else if (!search.data) {
    body = <Loading label="Searching…" />;
  } else {
    const found = search.data.filter((u) => u.id !== viewerId);
    if (found.length > 0) body = rows(found);
    else body = search.isPlaceholderData || typing ? <Loading label="Searching…" /> : <Hint text={`No users found for "${text}"`} />;
  }

  return (
    <View>
      <View className="px-4 pb-2 pt-1">
        <View className={cn('min-h-10 flex-row items-center gap-2 rounded-[10px] px-3', tw.bgMuted)}>
          <MagnifyingGlassIcon size={16} color={c.textSecondary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search by username..."
            placeholderTextColor={c.textPlaceholder}
            accessibilityLabel="Search by username"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            autoFocus={autoFocus}
            {...focusHandlers}
            returnKeyType="search"
            cursorColor={c.accent}
            selectionColor={c.accent}
            className="flex-1 text-gray-900 dark:text-gray-100"
            style={{ fontSize: 16, minHeight: 40, paddingVertical: 0 }}
            testID="picker-search"
          />
          {query.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              hitSlop={hitSlopFor(20)}
              onPress={() => setQuery('')}
            >
              <XCircleIcon size={18} color={c.textSecondary} />
            </Pressable>
          ) : null}
        </View>
        {note ? (
          <Text variant="caption" tone="secondary" className="mt-2">
            {note}
          </Text>
        ) : null}
      </View>
      {body}
    </View>
  );
}
