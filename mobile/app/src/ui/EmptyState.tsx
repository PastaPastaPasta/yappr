import type { ReactNode } from 'react';
import { View } from 'react-native';
import { ExclamationTriangleIcon, InboxIcon } from 'react-native-heroicons/outline';

import { Button } from './Button';
import { Spinner } from './Spinner';
import { Text } from './Text';
import { useColors, type IconComponent } from './tokens';

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: IconComponent;
  /** Defaults to `text.decorative`. */
  iconColor?: string;
  /** Optional button under the text. Its test ID is `<testID>-action` (PRD A11Y-08). */
  action?: { label: string; onPress: () => void };
  /** Anything else under the text (e.g. a link to the old app). */
  children?: ReactNode;
  testID?: string;
}

/** UX_SPEC §2.16: a 48 pt decorative icon, a title, a description and an optional button. */
export function EmptyState({
  title,
  description,
  icon: Icon = InboxIcon,
  iconColor,
  action,
  children,
  testID,
}: EmptyStateProps) {
  const c = useColors();
  return (
    <View className="items-center justify-center gap-2 px-6 py-12" testID={testID}>
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden className="mb-2">
        <Icon size={48} color={iconColor ?? c.textDecorative} />
      </View>
      <Text variant="title" tone="emphasis" accessibilityRole="header" className="text-center font-semibold">
        {title}
      </Text>
      {description ? (
        <Text variant="subhead" tone="secondary" className="max-w-[300px] text-center">
          {description}
        </Text>
      ) : null}
      {action ? (
        <Button
          label={action.label}
          onPress={action.onPress}
          className="mt-4"
          testID={testID ? `${testID}-action` : undefined}
        />
      ) : null}
      {children}
    </View>
  );
}

/**
 * "Retrying…" under a read's error while the app reads it again by itself
 * (PRD NET-03, UX_SPEC §5.11 `read.retrying`): the error stays up meanwhile.
 * Its test ID is `<testID>-retrying`. Not a live region: it comes back every
 * 30 s of an outage.
 */
export function RetryingNote({ testID }: { testID?: string }) {
  return (
    <View
      accessible
      accessibilityLabel="Retrying…"
      className="mt-3 flex-row items-center justify-center gap-2"
      testID={testID ? `${testID}-retrying` : undefined}
    >
      <Spinner size="xs" />
      <Text variant="caption" tone="secondary">
        Retrying…
      </Text>
    </View>
  );
}

export interface ErrorStateProps {
  /** The categorized message (UX_SPEC §5.12); the title stays "Something went wrong". */
  message?: string;
  onRetry?: () => void;
  /** The read is being read again by itself (a query's `isRetrying`): shows {@link RetryingNote}. */
  retrying?: boolean;
  testID?: string;
}

/** The error variant: a warning triangle and "Try again" (`primary`, not the web's purple). */
export function ErrorState({ message, onRetry, retrying = false, testID }: ErrorStateProps) {
  const c = useColors();
  return (
    <EmptyState
      title="Something went wrong"
      description={message}
      icon={ExclamationTriangleIcon}
      iconColor={c.warning}
      action={onRetry ? { label: 'Try again', onPress: onRetry } : undefined}
      testID={testID}
    >
      {retrying ? <RetryingNote testID={testID} /> : null}
    </EmptyState>
  );
}
