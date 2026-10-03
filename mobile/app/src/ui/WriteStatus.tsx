import { Fragment, useEffect, useRef } from 'react';
import { AccessibilityInfo, ActivityIndicator, View } from 'react-native';
import { ClockIcon, ExclamationCircleIcon } from 'react-native-heroicons/outline';

import { LinkText } from './LinkText';
import { Text } from './Text';
import { hitSlopFor, MIN_TARGET, useColors } from './tokens';

export type WriteState =
  | { state: 'posting' }
  | { state: 'threadProgress'; index: number; total: number }
  | { state: 'unconfirmed' }
  | { state: 'failed' }
  | { state: 'partial'; posted: number; total: number };

export interface WriteStatusProps {
  status: WriteState;
  /** Whose status: a recycled cell showing another post must not announce. */
  postId?: string;
  onCheckAgain?: () => void;
  onRetry?: () => void;
  onEdit?: () => void;
  /** "Retry the rest" of a partly posted thread. */
  onRetryRest?: () => void;
}

export interface WriteStatusLink {
  label: string;
  onPress?: () => void;
  /** `write-status-<id>` (PRD A11Y-08). */
  id: 'check-again' | 'retry' | 'edit' | 'retry-rest';
}

/** The actions a state offers, also exposed as the optimistic card's screen-reader actions. */
export function writeStatusLinks({
  status,
  onCheckAgain,
  onRetry,
  onEdit,
  onRetryRest,
}: WriteStatusProps): WriteStatusLink[] {
  switch (status.state) {
    case 'unconfirmed':
      return [{ label: 'Check again', onPress: onCheckAgain, id: 'check-again' }];
    case 'failed':
      return [
        { label: 'Retry', onPress: onRetry, id: 'retry' },
        { label: 'Edit', onPress: onEdit, id: 'edit' },
      ];
    case 'partial':
      return [{ label: 'Retry the rest', onPress: onRetryRest, id: 'retry-rest' }];
    default:
      return [];
  }
}

/** The sentence for a state (UX_SPEC §5.4), also what screen readers announce. */
function writeStatusText(status: WriteState): string {
  switch (status.state) {
    case 'posting':
      return 'Posting…';
    case 'threadProgress':
      return `Posting ${status.index} of ${status.total}…`;
    case 'unconfirmed':
      return 'Not confirmed yet';
    case 'failed':
      return "Couldn't post";
    case 'partial':
      return `Posted ${status.posted} of ${status.total}`;
  }
}

/**
 * Each action's target: its full height from vertical padding, and at least
 * the minimum width from its own frame, never from sideways padding, which
 * would reach over the "·" into its neighbour's (UX_SPEC §6.4).
 */
const LINK_SLOP = { ...hitSlopFor(20), left: 0, right: 0 };
const LINK_FRAME = { minWidth: MIN_TARGET, alignItems: 'center' } as const;

/**
 * The write-status line that replaces an optimistic card's action bar
 * (UX_SPEC §2.4.11): posting, not confirmed · check again, failed · retry ·
 * edit, and partly posted · retry the rest. Each change is announced once.
 */
export function WriteStatus(props: WriteStatusProps) {
  const { status } = props;
  const c = useColors();
  const text = writeStatusText(status);

  // Announce changes only (A11Y-06): not on mount, so scrolling past pending
  // posts stays quiet.
  const announced = useRef({ postId: props.postId, text });
  useEffect(() => {
    const last = announced.current;
    announced.current = { postId: props.postId, text };
    if (last.postId === props.postId && last.text !== text) AccessibilityInfo.announceForAccessibility(text);
  }, [props.postId, text]);

  const links = writeStatusLinks(props);
  const busy = status.state === 'posting' || status.state === 'threadProgress';

  return (
    <View testID="write-status" className="min-h-11 flex-row flex-wrap items-center gap-1.5 py-2">
      {busy ? (
        <View style={{ transform: [{ scale: 0.6 }] }}>
          <ActivityIndicator size="small" color={c.textSecondary} />
        </View>
      ) : null}
      {status.state === 'unconfirmed' ? <ClockIcon size={14} color={c.textSecondary} /> : null}
      {status.state === 'failed' ? <ExclamationCircleIcon size={14} color={c.error} /> : null}
      <Text variant="caption" tone={status.state === 'failed' ? 'error' : 'secondary'}>
        {text}
      </Text>
      {links.map((link) => (
        <Fragment key={link.label}>
          <Text variant="caption" tone="decorative">
            ·
          </Text>
          <LinkText
            label={link.label}
            onPress={link.onPress}
            variant="caption"
            role="button"
            hitSlop={LINK_SLOP}
            style={LINK_FRAME}
            testID={`write-status-${link.id}`}
          />
        </Fragment>
      ))}
    </View>
  );
}
