import { Stack } from 'expo-router';
import { View } from 'react-native';

import { Screen } from './Screen';
import { Text } from './Text';

export interface PlaceholderProps {
  /** Shown in the header and the body. */
  title: string;
  /** The PR that replaces this stub, e.g. "the feed PR". */
  comingIn: string;
  /** Route params or other context worth showing while the screen is a stub. */
  detail?: string;
}

/** Stand-in body for routes whose screen has not been built yet. */
export function Placeholder({ title, comingIn, detail }: PlaceholderProps) {
  return (
    <Screen>
      <Stack.Screen options={{ title }} />
      <View className="flex-1 items-center justify-center gap-2 px-8">
        <Text variant="titleLarge" tone="emphasis">
          {title}
        </Text>
        {detail ? (
          <Text variant="subhead" tone="secondary">
            {detail}
          </Text>
        ) : null}
        <Text variant="subhead" tone="secondary">
          Coming in {comingIn}
        </Text>
      </View>
    </Screen>
  );
}
