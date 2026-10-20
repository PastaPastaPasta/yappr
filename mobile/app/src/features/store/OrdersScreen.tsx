import type { BuyerOrderDTO, SellerOrderDTO } from '@engine/api';
import { FlashList } from '@shopify/flash-list';
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineInfiniteQuery } from '~/data/queries';
import { useViewerId } from '~/data/session';
import { formatOrderId } from '~/lib-allowlist';
import { Button } from '~/ui/Button';
import { Card } from '~/ui/Card';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { Screen } from '~/ui/Screen';
import { SegmentedControl } from '~/ui/Tabs';
import { Text } from '~/ui/Text';

import { DeliveryList, Loading, Notice, price, StatusPill, useRefreshControl } from './parts';

type OrderDTO = BuyerOrderDTO | SellerOrderDTO;

export function OrderRow({ order, title }: { order: OrderDTO; title: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open order ${formatOrderId(order.id)}`} testID={`order-${order.id}`} onPress={() => router.push(`/orders/${order.id}`)}>
      <Card className="mx-4 mb-3 gap-1 p-4">
        <View className="flex-row items-center justify-between gap-3">
          <Text variant="bodyStrong" className="flex-1" numberOfLines={1}>{title}</Text>
          <StatusPill status={order.status} />
        </View>
        <Text tone="secondary">
          {order.createdAt.toLocaleDateString()} · #{formatOrderId(order.id)}
          {order.payload ? ` · ${price(order.payload.total, order.payload.currency)}` : ''}
          {order.digital ? ' · Digital' : ''}
        </Text>
        {order.payload ? <Text tone="secondary" numberOfLines={1}>{order.payload.items.map((line) => `${line.quantity} × ${line.itemTitle}`).join(', ')}</Text> : null}
        {!order.payload ? <Text tone="warning">{order.locked ? 'Unlock to see this order.' : "This order's details couldn't be read."}</Text> : null}
      </Card>
    </Pressable>
  );
}

/** Web `/orders`: the viewer's orders as a buyer, and the digital library of what was delivered. */
export function OrdersScreen() {
  const viewerId = useViewerId();
  const [tab, setTab] = useState<'orders' | 'library'>('orders');
  const orders = useEngineInfiniteQuery(queryKeys.store.orders(), (api, cursor) => api.store.myOrders(cursor), { enabled: viewerId !== null });
  const refreshControl = useRefreshControl(() => orders.refetch());
  const library = orders.items.filter((order) => order.deliveries.length > 0);
  const rows = tab === 'orders' ? orders.items : library;
  const locked = orders.items.some((order) => order.locked);

  return (
    <Screen>
      <Stack.Screen options={{ title: 'My orders' }} />
      <FlashList
        data={rows}
        keyExtractor={(order) => order.id}
        refreshControl={refreshControl}
        ListHeaderComponent={
          <View className="gap-3 p-4">
            <SegmentedControl options={[{ value: 'orders', label: 'Orders' }, { value: 'library', label: 'Library' }]} value={tab} onChange={setTab} testID="orders-tabs" />
            {locked ? <Notice tone="warning" text="Unlock your account on this device to see your order details." /> : null}
          </View>
        }
        renderItem={({ item }) =>
          tab === 'orders' ? (
            <OrderRow order={item} title={item.storeName ?? 'Order'} />
          ) : (
            <View className="mx-4 mb-4 gap-2">
              <Pressable accessibilityRole="link" onPress={() => router.push(`/orders/${item.id}`)}>
                <Text variant="bodyStrong">{item.storeName ?? 'Order'} · #{formatOrderId(item.id)}</Text>
              </Pressable>
              <DeliveryList orderId={item.id} deliveries={item.deliveries} />
            </View>
          )
        }
        ListEmptyComponent={
          orders.isPending ? <Loading /> : orders.isError ? (
            <ErrorState message="Your orders couldn't be loaded." onRetry={() => orders.refetch()} retrying={orders.isRetrying} />
          ) : tab === 'library' ? (
            <EmptyState title="Nothing delivered yet" description="Files, links and codes sellers deliver to you appear here." />
          ) : (
            <EmptyState title="No orders yet" description="Orders you place appear here." action={{ label: 'Browse stores', onPress: () => router.push('/store') }} />
          )
        }
        ListFooterComponent={orders.hasNextPage ? <Button className="m-4" variant="outline" label="Load more" loading={orders.isFetchingNextPage} onPress={() => orders.fetchNextPage()} /> : null}
      />
    </Screen>
  );
}
