import { View } from 'react-native';
import {
  ExclamationTriangleIcon,
  NoSymbolIcon,
  ShieldExclamationIcon,
  TrashIcon,
} from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';

import { Text } from '../Text';
import { tw, useColors } from '../tokens';
import { EMBED_FRAME } from './embed-frame';
import type { CardKind } from './types';

export type StubState = 'removed' | 'deleted' | 'failed' | 'unavailable' | 'blocked';

const ICONS = {
  removed: ShieldExclamationIcon,
  deleted: TrashIcon,
  failed: ExclamationTriangleIcon,
  unavailable: ExclamationTriangleIcon,
  blocked: NoSymbolIcon,
} as const;

/** The stub sentence (UX_SPEC §5.3, web removed-post-stub.tsx). */
export function stubText(state: StubState, kind: CardKind): string {
  const noun = kind === 'reply' ? 'reply' : 'post';
  switch (state) {
    case 'removed':
      return `This ${noun} was removed by the contract's moderators.`;
    case 'deleted':
      return `This ${noun} was deleted by its author.`;
    case 'failed':
      return `This ${noun} could not be loaded. Try again later.`;
    case 'unavailable':
      return `This ${noun} is unavailable.`;
    case 'blocked':
      return kind === 'reply' ? 'Reply from an account you blocked' : 'Post from an account you blocked';
  }
}

export interface PostStubProps {
  state: StubState;
  kind?: CardKind;
  /** `card`: a feed row. `embed`: inside a quote frame. */
  variant?: 'card' | 'embed';
  /** A moderator's stated reason, for `removed`. */
  reason?: string;
  /** v11 kept fields of a removed post: its first tag and date, e.g. "#dash · posted Sep 30". */
  kept?: string;
  testID?: string;
}

/**
 * The hole a removed, deleted, unloadable or blocked post leaves (UX_SPEC
 * §2.5): one italic line with its icon, plus the reason or kept fields. Not
 * tappable, and one static element for screen readers.
 */
export function PostStub({ state, kind = 'post', variant = 'card', reason, kept, testID }: PostStubProps) {
  const c = useColors();
  const Icon = ICONS[state];
  const text = stubText(state, kind);
  const detail = state === 'removed' && reason ? `Reason: ${reason}` : kept;

  return (
    <View
      accessible
      accessibilityLabel={detail ? `${text} ${detail}` : text}
      testID={testID ?? `stub-${state}`}
      className={cn(
        'gap-1',
        variant === 'embed' ? cn(EMBED_FRAME, 'p-3') : cn('border-b px-4 py-3', tw.border),
      )}
    >
      <View className="flex-row items-center gap-2">
        <Icon size={16} color={c.textSecondary} />
        <Text variant="subhead" tone="secondary" className="shrink italic">
          {text}
        </Text>
      </View>
      {detail ? (
        <Text variant="subhead" tone="secondary">
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

/** A v9 tombstone's line inside its card or quote: the author deleted it, the document stays. */
export function DeletedLine({ kind }: { kind: CardKind }) {
  return (
    <Text variant="subhead" tone="secondary" className="mt-1 italic">
      {stubText('deleted', kind)}
    </Text>
  );
}
