import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';

export interface ScreenProps {
  children: ReactNode;
  /** Wrap content in a ScrollView. Lists bring their own scroller instead. */
  scroll?: boolean;
  className?: string;
}

/**
 * The page surface every screen sits on: the web's `bg-white
 * dark:bg-neutral-900`. Navigator headers and the tab bar own the safe-area
 * insets, so this adds none.
 */
export function Screen({ children, scroll = false, className }: ScreenProps) {
  const surface = `flex-1 bg-white dark:bg-neutral-900 ${className ?? ''}`;
  if (scroll) {
    return (
      <ScrollView className={surface} contentInsetAdjustmentBehavior="automatic">
        {children}
      </ScrollView>
    );
  }
  return <View className={surface}>{children}</View>;
}
