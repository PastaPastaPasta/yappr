import type { ComponentType, ReactNode } from 'react';
import { View } from 'react-native';
import { ExclamationTriangleIcon, InboxIcon } from 'react-native-heroicons/outline';

import { Button } from './Button';
import { Text } from './Text';
import { useColors } from './tokens';

type IconComponent = ComponentType<{ size?: number; color?: string }>;

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: IconComponent;
  /** Defaults to `text.decorative`. */
  iconColor?: string;
  /** Optional button under the text. */
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
      {action ? <Button label={action.label} onPress={action.onPress} className="mt-4" /> : null}
      {children}
    </View>
  );
}

export interface ErrorStateProps {
  /** The categorized message (UX_SPEC §5.12); the title stays "Something went wrong". */
  message?: string;
  onRetry?: () => void;
  testID?: string;
}

/** The error variant: a warning triangle and "Try again" (`primary`, not the web's purple). */
export function ErrorState({ message, onRetry, testID }: ErrorStateProps) {
  const c = useColors();
  return (
    <EmptyState
      title="Something went wrong"
      description={message}
      icon={ExclamationTriangleIcon}
      iconColor={c.warning}
      action={onRetry ? { label: 'Try again', onPress: onRetry } : undefined}
      testID={testID}
    />
  );
}
