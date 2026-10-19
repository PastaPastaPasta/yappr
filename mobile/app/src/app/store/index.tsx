import type { Store } from '@engine/api'
import { FlashList } from '@shopify/flash-list'
import { router, Stack } from 'expo-router'
import { Pressable, RefreshControl, View } from 'react-native'
import { useState } from 'react'
import { useEngineQuery } from '~/data/queries'
import { queryKeys } from '~/data/keys'
import { Screen } from '~/ui/Screen'
import { Text } from '~/ui/Text'
import { Card } from '~/ui/Card'
import { tw } from '~/ui/tokens'

export default function StoreDirectory() {
  const [refreshing, setRefreshing] = useState(false)
  const stores = useEngineQuery(queryKeys.store.discover(), api => api.store.discover({ sort: 'newest', limit: 30 }), { persist: true })
  const rows = stores.data?.stores ?? []
  return <Screen>
    <Stack.Screen options={{ title: 'Stores', headerLargeTitle: true }} />
    <FlashList data={rows} keyExtractor={(s: Store) => s.id} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); stores.refetch().finally(() => setRefreshing(false)).catch(() => undefined) }} />} contentContainerStyle={{ padding: 16 }} renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`Open ${item.name}`} onPress={() => router.push(`/store/${item.id}`)} style={{ minHeight: 44 }}><Card className="mb-3 p-4"><Text variant="bodyStrong">{item.name}</Text><Text tone="secondary" className="mt-1">{item.description || 'Browse this store'}</Text><Text tone="secondary" className="mt-2">{item.location || 'Online store'}</Text></Card></Pressable>} ListEmptyComponent={<View className="p-6"><Text variant="bodyStrong">No stores yet</Text><Text tone="secondary" className="mt-2">Check back soon for new independent sellers.</Text></View>} />
  </Screen>
}
