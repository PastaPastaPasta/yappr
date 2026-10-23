import { Stack } from 'expo-router';
import { Text as RNText, View } from 'react-native';
import { EyeSlashIcon } from 'react-native-heroicons/outline';

import { Screen } from '~/ui/Screen';
import { useColors } from '~/ui/tokens';

/** What the moderators hid, in the words web's stub uses ("This blog post is hidden by moderators."). */
type HiddenNoun = 'blog' | 'blog post' | 'comment';

/**
 * What a blog, post or comment the moderators hid shows on the official apps
 * (blog v10; web `HiddenContentStub`): one calm line, none of its content and
 * nothing to act on. Hiding never deletes: it is still on the network.
 */
export function BlogHiddenStub({ noun, color, testID }: { noun: HiddenNoun; color: string; testID?: string }) {
  const text = `This ${noun} is hidden by moderators.`;
  return (
    <View accessible accessibilityLabel={text} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 }} testID={testID}>
      <EyeSlashIcon size={16} color={color} />
      <RNText style={{ flexShrink: 1, color, fontSize: 15, fontStyle: 'italic' }}>{text}</RNText>
    </View>
  );
}

/** A whole screen given over to the stub: a hidden blog's home, or a hidden post (or a post in a hidden blog). */
export function BlogHiddenScreen({ title, noun }: { title: string; noun: HiddenNoun }) {
  const c = useColors();
  return (
    <Screen>
      <Stack.Screen options={{ title }} />
      <View className="px-4">
        <BlogHiddenStub noun={noun} color={c.textSecondary} />
      </View>
    </Screen>
  );
}
