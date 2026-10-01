import type { ReactNode } from 'react';
import { View } from 'react-native';

import { EmptyState, ErrorState } from './EmptyState';
import { Spinner } from './Spinner';
import { Text } from './Text';

export interface LoadingStateProps {
  loading: boolean;
  error?: string | null;
  isEmpty?: boolean;
  onRetry?: () => void;
  children: ReactNode;
  loadingText?: string;
  emptyText?: string;
  emptyDescription?: string;
  /** Rendered under the empty description (e.g. a link to the old app). */
  emptyAction?: ReactNode;
}

/**
 * components/ui/loading-state.tsx: a spinner, the error state, the empty
 * state, or the children, in that order of precedence.
 */
export function LoadingState({
  loading,
  error,
  isEmpty,
  onRetry,
  children,
  loadingText = 'Loading...',
  emptyText = 'No data found',
  emptyDescription = "There's nothing here yet.",
  emptyAction,
}: LoadingStateProps) {
  if (loading) {
    return (
      <View className="items-center justify-center gap-4 p-8" testID="loading-state">
        <Spinner size="md" />
        <Text variant="subhead" tone="secondary">
          {loadingText}
        </Text>
      </View>
    );
  }
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (isEmpty) {
    return (
      <EmptyState title={emptyText} description={emptyDescription}>
        {emptyAction}
      </EmptyState>
    );
  }
  return <>{children}</>;
}
