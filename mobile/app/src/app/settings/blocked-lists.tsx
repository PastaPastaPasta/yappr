import { Stack } from 'expo-router'
import { View } from 'react-native'
import { Screen } from '~/ui/Screen'
import { Text } from '~/ui/Text'

export default function BlockedListsScreen() {
  return <Screen><Stack.Screen options={{ title: 'Block lists' }} /><View className="gap-3 p-4"><Text variant="headline">Block lists</Text><Text variant="body" tone="secondary">Follow or unfollow block lists from a person’s profile. Changes take effect as soon as the network confirms them.</Text></View></Screen>
}
