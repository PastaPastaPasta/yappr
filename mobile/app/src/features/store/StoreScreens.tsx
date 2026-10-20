import type { Store, StoreItem } from '@engine/api';
import { FlashList } from '@shopify/flash-list';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Pressable, View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { requireAuth } from '~/data/require-auth';
import { Button } from '~/ui/Button';
import { Card } from '~/ui/Card';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { Screen } from '~/ui/Screen';
import { Text } from '~/ui/Text';

import { Loading, price, Section, Stars, useRefreshControl } from './parts';
import { ReportLink } from './StoreReportScreen';

/** Cart, orders and the seller's own store, from the directory's header. */
function ShopActions() {
  const cart = useEngineQuery(queryKeys.store.cart(), (api) => api.cart.get());
  const count = cart.data?.count ?? 0;
  return (
    <View className="flex-row flex-wrap gap-2">
      <Button size="sm" variant="outline" testID="store-open-cart" label={count > 0 ? `Cart (${count})` : 'Cart'} onPress={() => router.push('/cart')} />
      <Button size="sm" variant="outline" testID="store-open-orders" label="My orders" onPress={() => requireAuth(() => router.push('/orders'))} />
      <Button size="sm" variant="outline" testID="store-open-manage" label="My store" onPress={() => requireAuth(() => router.push('/store/manage'))} />
    </View>
  );
}

/** Web `/store`: the newest open stores. */
export function StoreDirectoryScreen() {
  const stores = useEngineQuery(queryKeys.store.discover(), (api) => api.store.discover({ sort: 'newest', limit: 30 }), { persist: true });
  const refreshControl = useRefreshControl(() => stores.refetch());
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Stores', headerLargeTitle: true }} />
      <FlashList
        data={stores.data?.stores ?? []}
        keyExtractor={(store: Store) => store.id}
        refreshControl={refreshControl}
        contentContainerStyle={{ padding: 16 }}
        ListHeaderComponent={<View className="mb-4"><ShopActions /></View>}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" accessibilityLabel={`Open ${item.name}`} testID={`store-${item.id}`} onPress={() => router.push(`/store/${item.id}`)} style={{ minHeight: 44 }}>
            <Card className="mb-3 p-4">
              <Text variant="bodyStrong">{item.name}</Text>
              <Text tone="secondary" className="mt-1" numberOfLines={2}>{item.description || 'Browse this store'}</Text>
              <Text tone="secondary" className="mt-2">{item.location || 'Online store'}</Text>
            </Card>
          </Pressable>
        )}
        ListEmptyComponent={
          stores.isPending ? <Loading /> : stores.isError ? (
            <ErrorState message="Stores couldn't be loaded." onRetry={() => stores.refetch()} retrying={stores.isRetrying} />
          ) : (
            <EmptyState title="No stores yet" description="Check back soon for new independent sellers." />
          )
        }
      />
    </Screen>
  );
}

function ItemCard({ item, currency }: { item: StoreItem; currency?: string }) {
  const low = item.variants?.combinations.reduce((min, combination) => Math.min(min, combination.price), Number.POSITIVE_INFINITY);
  const amount = item.basePrice ?? (low !== undefined && Number.isFinite(low) ? low : undefined);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`View ${item.title}`} testID={`item-${item.id}`} onPress={() => router.push(`/item/${item.id}`)} style={{ minHeight: 44 }}>
      <Card className="mx-4 mb-3 p-4">
        <Text variant="bodyStrong">{item.title}</Text>
        {item.description ? <Text tone="secondary" className="mt-1" numberOfLines={2}>{item.description}</Text> : null}
        <Text variant="bodyStrong" className="mt-2">
          {amount !== undefined ? `${item.variants && item.basePrice === undefined ? 'From ' : ''}${price(amount, item.currency ?? currency)}` : 'See options'}
          {item.fulfillment === 'digital' ? ' · Digital' : ''}
        </Text>
        {item.stockQuantity === 0 || item.status === 'sold_out' ? <Text tone="secondary">Sold out</Text> : null}
      </Card>
    </Pressable>
  );
}

/** Web `/store/view`: the store, its rating, products, reviews and policies. */
export function StoreScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const detail = useEngineQuery(queryKeys.store.page(id), (api) => api.store.detail(id));
  const items = useEngineQuery(queryKeys.store.items(id), (api) => api.store.items({ storeId: id, activeOnly: true, limit: 50 }), { persist: true });
  const reviews = useEngineQuery(queryKeys.store.reviews(id), (api) => api.store.reviews(id));
  const refreshControl = useRefreshControl(() => Promise.all([detail.refetch(), items.refetch(), reviews.refetch()]));
  const value = detail.data?.store;

  const header = (
    <View className="gap-2 p-4">
      <Text variant="title">{value?.name ?? (detail.isPending ? 'Loading…' : 'Store')}</Text>
      {detail.data?.rating ? (
        <View className="flex-row items-center gap-2"><Stars rating={detail.data.rating.average} /><Text tone="secondary">{detail.data.rating.count} reviews</Text></View>
      ) : null}
      {value?.description ? <Text tone="secondary">{value.description}</Text> : null}
      {value?.location ? <Text tone="secondary">{value.location}</Text> : null}
      {value && value.status !== 'active' ? <Text tone="warning">This store is currently {value.status === 'paused' ? 'taking a break' : 'closed'}.</Text> : null}
      {detail.data?.own ? <Button size="sm" variant="outline" label="Manage your store" onPress={() => router.push('/store/manage')} /> : null}
      <View className="mt-2"><ShopActions /></View>
      <Text variant="headline" className="mt-4">Products</Text>
    </View>
  );

  const footer = (
    <View className="px-4 pb-12">
      <Section title="Reviews">
        {(reviews.data?.reviews ?? []).length === 0 ? <Text tone="secondary">No reviews yet.</Text> : null}
        {reviews.data?.reviews.map((review) => (
          <View key={review.id} className="gap-1 border-b border-gray-200 py-3 dark:border-gray-800">
            <Stars rating={review.rating} />
            {review.title ? <Text variant="bodyStrong">{review.title}</Text> : null}
            {review.content ? <Text>{review.content}</Text> : null}
            <Text variant="caption" tone="secondary">{review.createdAt.toLocaleDateString()}</Text>
          </View>
        ))}
      </Section>
      {value ? <ReportLink target={{ docType: 'store', targetId: value.id, ownerId: value.ownerId }} noun="store" /> : null}
    </View>
  );

  if (detail.isError && !value) return <Screen><ErrorState message="This store couldn't be loaded." onRetry={() => detail.refetch()} retrying={detail.isRetrying} /></Screen>;
  return (
    <Screen>
      <Stack.Screen options={{ title: value?.name ?? 'Store' }} />
      <FlashList
        data={items.data?.items ?? []}
        keyExtractor={(item) => item.id}
        refreshControl={refreshControl}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        renderItem={({ item }) => <ItemCard item={item} currency={value?.defaultCurrency} />}
        ListEmptyComponent={items.isPending ? <Loading /> : <Text className="px-4" tone="secondary">No products are available right now.</Text>}
      />
    </Screen>
  );
}
