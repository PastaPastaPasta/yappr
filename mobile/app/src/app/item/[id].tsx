import { Stack, useLocalSearchParams } from 'expo-router'
import { ScrollView, View } from 'react-native'
import { useEngineQuery } from '~/data/queries'
import { queryKeys } from '~/data/keys'
import { Screen } from '~/ui/Screen'
import { Text } from '~/ui/Text'
import { Card } from '~/ui/Card'

export default function ItemDetail() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const item = useEngineQuery(queryKeys.store.item(id), api => api.store.item(id), { persist: true })
  const reviews = useEngineQuery(queryKeys.store.reviews(id), api => api.store.itemReviews(id), { persist: true })
  const value = item.data
  return <Screen><Stack.Screen options={{ title: value?.title ?? 'Product' }} /><ScrollView contentContainerStyle={{ padding: 16 }}><Text variant="title">{value?.title ?? 'Loading…'}</Text><Text tone="secondary" className="mt-2">{value?.description}</Text>{value?.imageUrls?.length ? <Text tone="secondary" className="mt-3">{value.imageUrls.length} photos</Text> : null}<Card className="mt-4 p-4"><Text variant="bodyStrong">{value?.basePrice !== undefined ? `${value.currency ?? ''} ${value.basePrice}` : 'Price shown at checkout'}</Text><Text tone="secondary" className="mt-2">{value?.stockQuantity === 0 ? 'Sold out' : value?.fulfillment === 'digital' ? 'Digital delivery' : 'Ships to selected zones'}</Text></Card><Text variant="headline" className="mt-6">Reviews</Text>{reviews.data?.reviews.map(review => <View key={review.id} className="mt-3"><Text variant="bodyStrong">{'★'.repeat(review.rating)}</Text><Text>{review.content}</Text></View>)}</ScrollView></Screen>
}
