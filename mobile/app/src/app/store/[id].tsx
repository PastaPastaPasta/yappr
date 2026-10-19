import { FlashList } from '@shopify/flash-list'
import { Stack, useLocalSearchParams, router } from 'expo-router'
import { Pressable, View } from 'react-native'
import { useEngineQuery } from '~/data/queries'
import { queryKeys } from '~/data/keys'
import { Screen } from '~/ui/Screen'
import { Text } from '~/ui/Text'
import { Card } from '~/ui/Card'

export default function StoreDetail() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const store = useEngineQuery(queryKeys.store.detail(id), api => api.store.get(id), { persist: true })
  const items = useEngineQuery(queryKeys.store.items(id), api => api.store.items({ storeId: id, activeOnly: true, limit: 50 }), { persist: true })
  const value = store.data
  return <Screen><Stack.Screen options={{ title: value?.name ?? 'Store' }} /><FlashList data={items.data?.items ?? []} keyExtractor={item => item.id} ListHeaderComponent={<View className="gap-2 p-4"><Text variant="title">{value?.name ?? 'Loading…'}</Text><Text tone="secondary">{value?.description}</Text>{value?.status !== 'active' ? <Text tone="secondary">This store is currently taking a break.</Text> : null}</View>} renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`View ${item.title}`} onPress={() => router.push(`/item/${item.id}`)} style={{ minHeight: 44 }}><Card className="mx-4 mb-3 p-4"><Text variant="bodyStrong">{item.title}</Text><Text tone="secondary" className="mt-1">{item.description}</Text><Text variant="bodyStrong" className="mt-2">{item.basePrice !== undefined ? `${item.currency ?? value?.defaultCurrency ?? ''} ${item.basePrice}` : 'See options'}</Text>{item.stockQuantity === 0 ? <Text tone="secondary">Sold out</Text> : null}</Card></Pressable>} ListEmptyComponent={<Text className="p-4" tone="secondary">No products are available right now.</Text>} /></Screen>
}
