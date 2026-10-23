import { Text as RNText, View } from 'react-native';
import { EyeSlashIcon } from 'react-native-heroicons/outline';

/** What the moderators hid, in the words web's stub uses ("This blog post is hidden by moderators."). */
export type HiddenNoun = 'blog' | 'blog post' | 'comment';

export const hiddenText = (noun: HiddenNoun) => `This ${noun} is hidden by moderators.`;

/**
 * What a blog, post or comment the moderators hid shows on the official apps
 * (blog v10; web `HiddenContentStub`): one calm line, none of its content and
 * nothing to act on. Hiding never deletes: it is still on the network.
 */
export function BlogHiddenStub({ noun, color, testID }: { noun: HiddenNoun; color: string; testID?: string }) {
  const text = hiddenText(noun);
  return (
    <View accessible accessibilityLabel={text} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 }} testID={testID ?? `blog-hidden-${noun.replace(' ', '-')}`}>
      <EyeSlashIcon size={16} color={color} />
      <RNText style={{ flexShrink: 1, color, fontSize: 15, fontStyle: 'italic' }}>{text}</RNText>
    </View>
  );
}
