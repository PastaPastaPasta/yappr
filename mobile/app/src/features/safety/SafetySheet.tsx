import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';

import { Button } from '~/ui/Button';
import { EmptyState } from '~/ui/EmptyState';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { useColors, type IconComponent } from '~/ui/tokens';

import { copy } from './copy';

/** Leaves the modal (or, opened by a link with nothing under it, goes home). */
export function closeSheet(): void {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

/**
 * The body of the block and report modals (UX_SPEC §4.39): a scrolling
 * column on the page surface that keeps its fields above the keyboard.
 */
export function SheetBody({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <ScrollView
      className="flex-1 bg-white dark:bg-neutral-900"
      contentContainerClassName="gap-4 px-5 pb-10 pt-6"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentInsetAdjustmentBehavior="automatic"
      testID={testID}
    >
      {children}
    </ScrollView>
  );
}

/** A sheet's title with its icon and explanation. */
export function SheetHeading({
  icon: Icon,
  iconColor,
  title,
  body,
}: {
  icon: IconComponent;
  iconColor?: string;
  /** Left out where the header already says it ("Report post"). */
  title?: string;
  body?: string;
}) {
  const c = useColors();
  return (
    <View className="gap-2">
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Icon size={28} color={iconColor ?? c.textSecondary} />
      </View>
      {title ? (
        <Text variant="title" tone="emphasis" accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      {body ? (
        <Text variant="body" tone="secondary">
          {body}
        </Text>
      ) : null}
    </View>
  );
}

/** A centered spinner with a line under it, while the sheet reads what it needs. */
export function SheetLoading({ label, testID }: { label?: string; testID?: string }) {
  return (
    <View className="flex-1 items-center justify-center gap-3 bg-white p-8 dark:bg-neutral-900" testID={testID}>
      <Spinner />
      {label ? (
        <Text variant="subhead" tone="secondary" className="text-center">
          {label}
        </Text>
      ) : null}
    </View>
  );
}

/** A full-sheet message (signed out, own post, gone) with an optional action and Close. */
export function SheetMessage({
  title,
  description,
  icon,
  action,
  testID,
}: {
  title: string;
  description?: string;
  icon?: IconComponent;
  action?: { label: string; onPress: () => void };
  testID?: string;
}) {
  return (
    <View className="flex-1 bg-white dark:bg-neutral-900">
      <EmptyState title={title} description={description} icon={icon} action={action} testID={testID}>
        <Button label="Close" variant="ghost" onPress={closeSheet} className="mt-2" testID="sheet-close" />
      </EmptyState>
    </View>
  );
}

/** "Sign in" from a modal: the sign-in flow takes over, and the modal goes. */
function signInFromSheet(): void {
  closeSheet();
  router.push('/sign-in');
}

export const signInAction = { label: copy.signIn, onPress: signInFromSheet };
