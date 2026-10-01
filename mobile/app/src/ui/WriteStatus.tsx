import { Fragment, useEffect, useRef } from 'react';
import { AccessibilityInfo, ActivityIndicator, View } from 'react-native';
import { ClockIcon, ExclamationCircleIcon } from 'react-native-heroicons/outline';

import { LinkText } from './LinkText';
import { Text } from './Text';
import { useColors } from './tokens';

export type WriteState =
  | { state: 'posting' }
  | { state: 'threadProgress'; index: number; total: number }
  | { state: 'unconfirmed' }
  | { state: 'failed' }
  | { state: 'partial'; posted: number; total: number };

export interface WriteStatusProps {
  status: WriteState;
  onCheckAgain?: () => void;
  onRetry?: () => void;
  onEdit?: () => void;
  /** "Retry the rest" of a partly posted thread. */
  onRetryRest?: () => void;
}

export interface WriteStatusLink {
  label: string;
  onPress?: () => void;
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
      return [{ label: 'Check again', onPress: onCheckAgain }];
    case 'failed':
      return [
        { label: 'Retry', onPress: onRetry },
        { label: 'Edit', onPress: onEdit },
      ];
    case 'partial':
      return [{ label: 'Retry the rest', onPress: onRetryRest }];
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
 * The write-status line that replaces an optimistic card's action bar
 * (UX_SPEC §2.4.11): posting, not confirmed · check again, failed · retry ·
 * edit, partly posted · retry the rest. Each change is announced once.
 */
export function WriteStatus(props: WriteStatusProps) {
  const { status } = props;
  const c = useColors();
  const text = writeStatusText(status);

  // Announce changes only (A11Y-06): not on mount, so scrolling past pending
  // posts stays quiet.
  const announced = useRef(text);
  useEffect(() => {
    if (announced.current === text) return;
    announced.current = text;
    AccessibilityInfo.announceForAccessibility(text);
  }, [text]);

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
          <LinkText label={link.label} onPress={link.onPress} variant="caption" role="button" />
        </Fragment>
      ))}
    </View>
  );
}
