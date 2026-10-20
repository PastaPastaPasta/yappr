import { FlashList } from '@shopify/flash-list';
import { Stack } from 'expo-router';
import { useState } from 'react';
import { Alert, View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineInfiniteQuery } from '~/data/queries';
import { engine } from '~/engine';
import { UnlockSheet } from '~/features/messages/UnlockSheet';
import { queryClient } from '~/state/query-client';
import { Button } from '~/ui/Button';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { Screen } from '~/ui/Screen';
import { toast } from '~/ui/toast';

import { OrderRow } from './OrdersScreen';
import { errorText, Loading, Notice, useRefreshControl } from './parts';

/** Web `/orders/seller`: orders placed with the viewer's store, and "Deliver all" for digital ones that are ready. */
export function SellerOrdersScreen() {
  const orders = useEngineInfiniteQuery(queryKeys.store.sellerOrders(), (api, cursor) => api.store.sellerOrders(cursor));
  const refreshControl = useRefreshControl(() => orders.refetch());
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [bulk, setBulk] = useState(false);
  const ready = orders.items.filter((order) => order.readyToDeliver).length;
  const locked = orders.items.some((order) => order.locked);

  const deliverAll = () => {
    setBulk(true);
    engine.api.store.deliverReady()
      .then((result) => {
        if (result.delivered > 0) toast.success(`Delivered ${result.delivered} order${result.delivered === 1 ? '' : 's'}`);
        if (result.skipped.length > 0) toast.error(`${result.skipped.length} not delivered.${result.firstFailure ? ` ${result.firstFailure}` : ''} Open each order to deliver it.`);
        // Codes out of their pools: the seller must see them, and they are recorded nowhere else.
        if (result.recoveryTexts.length > 0) Alert.alert('Check these unique codes', result.recoveryTexts.join('\n\n'));
        for (const warning of result.warnings) toast.error(warning);
      })
      .catch((error: unknown) => toast.error(errorText(error, "Couldn't deliver the orders.")))
      .finally(() => {
        setBulk(false);
        queryClient.invalidateQueries({ queryKey: queryKeys.store.orders() }).catch(() => undefined);
      });
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Store orders' }} />
      <FlashList
        data={orders.items}
        keyExtractor={(order) => order.id}
        refreshControl={refreshControl}
        ListHeaderComponent={
          <View className="px-4 pb-3">
            {locked ? (
              <Notice tone="warning" text="Unlock your account on this device to see order details.">
                <Button size="sm" label="Unlock" onPress={() => setUnlockOpen(true)} />
              </Notice>
            ) : null}
            {ready > 0 || bulk ? (
              <Notice text={bulk ? 'Delivering…' : `${ready} digital order${ready === 1 ? ' is' : 's are'} ready to deliver.`}>
                <Button size="sm" label="Deliver all" testID="seller-deliver-all" loading={bulk} onPress={deliverAll} />
              </Notice>
            ) : null}
          </View>
        }
        renderItem={({ item }) => <OrderRow order={item} title={`From ${item.buyerName ? `@${item.buyerName}` : 'a buyer'}`} />}
        ListEmptyComponent={
          orders.isPending ? <Loading /> : orders.isError ? (
            <ErrorState message="Your store's orders couldn't be loaded." onRetry={() => orders.refetch()} retrying={orders.isRetrying} />
          ) : (
            <EmptyState title="No orders yet" description="Orders from buyers appear here." />
          )
        }
        ListFooterComponent={orders.hasNextPage ? <Button className="m-4" variant="outline" label="Load more" loading={orders.isFetchingNextPage} onPress={() => orders.fetchNextPage()} /> : null}
      />
      <UnlockSheet open={unlockOpen} onClose={() => { setUnlockOpen(false); orders.refetch().catch(() => undefined); }} />
    </Screen>
  );
}
