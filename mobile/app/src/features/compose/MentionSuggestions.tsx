import type { UserSummaryDTO } from '@engine/api';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { cn } from '~/lib-allowlist';
import { Avatar } from '~/ui/Avatar';
import { Text } from '~/ui/Text';
import { tw } from '~/ui/tokens';

import { MENTION_MIN_CHARS } from './text';

/** Up to 8 matches; about 4 rows show before the list scrolls (UX_SPEC §2.12). */
const MAX_RESULTS = 8;
const ROW_HEIGHT = 56;
const DEBOUNCE_MS = 250;

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export interface MentionSuggestionsProps {
  /** The name typed after `@`, or '' when the caret is not in a mention. */
  query: string;
  onSelect: (user: UserSummaryDTO) => void;
}

/**
 * The @-mention suggestions docked above the accessory bar (PRD COMP-06):
 * DPNS names by prefix (`posts.mentionCandidates`), avatar, name and
 * handle. Hidden while nothing matches.
 */
export function MentionSuggestions({ query, onSelect }: MentionSuggestionsProps) {
  const debounced = useDebounced(query, DEBOUNCE_MS);
  const active = query.length >= MENTION_MIN_CHARS && debounced.length >= MENTION_MIN_CHARS;
  const { data } = useEngineQuery(
    queryKeys.explore.mentions(debounced),
    (api) => api.posts.mentionCandidates(debounced),
    { enabled: active, staleTime: 60_000 },
  );
  const users = (data ?? []).filter((user) => user.username).slice(0, MAX_RESULTS);
  if (!active || users.length === 0) return null;

  return (
    <View
      className={cn('rounded-t-xl border-x border-t bg-white shadow-lg dark:bg-gray-900', tw.border)}
      style={{ maxHeight: ROW_HEIGHT * 4 }}
      testID="mention-suggestions"
      accessibilityRole="list"
    >
      <ScrollView keyboardShouldPersistTaps="always">
        {users.map((user) => (
          <Pressable
            key={user.id}
            accessibilityRole="button"
            accessibilityLabel={`${user.displayName}, @${user.username}`}
            onPress={() => onSelect(user)}
            className={cn('flex-row items-center gap-3 px-4', tw.pressedMuted)}
            style={{ height: ROW_HEIGHT }}
            testID={`mention-${user.username}`}
          >
            <Avatar avatar={user.avatar} identityId={user.id} size="md" />
            <View className="min-w-0 flex-1">
              <Text variant="bodyStrong" numberOfLines={1}>
                {user.displayName}
              </Text>
              <Text variant="subhead" tone="secondary" numberOfLines={1}>
                @{user.username}
              </Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
