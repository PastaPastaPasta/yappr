import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useViewerId } from '~/data/session';
import { useLandingIntent } from '~/data/writes';
import { UnlockSheet } from '~/features/messages/UnlockSheet';
import { Button } from '~/ui/Button';
import { Card } from '~/ui/Card';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { Screen } from '~/ui/Screen';
import { Text } from '~/ui/Text';

import { Loading, Notice, price, Section, useRefreshControl } from './parts';
import { STORE_CREATE_KEY, useConfirmingStores } from './store-writes';

const STATUS_LABEL = { active: 'Open', paused: 'Paused', closed: 'Closed' } as const;
const ITEM_STATUS = { active: 'Active', paused: 'Paused', sold_out: 'Sold out', deleted: 'Removed' } as const;

/** Web `/store/manage`: the seller's store, its products and shipping zones, and the way to its orders. */
export function StoreManageScreen() {
  const manage = useEngineQuery(queryKeys.store.manage(), (api) => api.store.manage());
  const refreshControl = useRefreshControl(() => manage.refetch());
  const [unlockOpen, setUnlockOpen] = useState(false);
  // A create that may still land: never offer a second one meanwhile.
  const viewer = useViewerId();
  const confirming = useConfirmingStores(({ owners }) => viewer !== null && owners.has(viewer));
  const creating = useLandingIntent(STORE_CREATE_KEY) !== undefined || confirming;
  const data = manage.data;

  return (
    <Screen>
      <Stack.Screen options={{ title: 'My store' }} />
      {manage.isPending ? <Loading /> : !data ? (
        <ErrorState message="Your store couldn't be loaded." onRetry={() => manage.refetch()} retrying={manage.isRetrying} />
      ) : !data.store && creating ? (
        <EmptyState title="Creating your store" description="It will appear here in a moment." testID="store-manage-creating" />
      ) : !data.store ? (
        <EmptyState
          title="Open your store"
          description="Sell physical or digital products. Buyers pay you directly."
          action={{ label: 'Create store', onPress: () => router.push('/store/edit') }}
          testID="store-manage-empty"
        />
      ) : (
        <ScrollView refreshControl={refreshControl} contentContainerStyle={{ padding: 16, paddingBottom: 48 }} testID="store-manage">
          <Text variant="title">{data.store.name}</Text>
          <Text tone="secondary">{STATUS_LABEL[data.store.status]}{data.store.category ? ` · ${data.store.category}` : ''}</Text>
          {!data.canTakeOrders ? <Notice tone="warning" text="Set up messaging to start taking orders." /> : null}
          {!data.keyOnDevice ? (
            <Notice tone="warning" text="Unlock your account on this device to see orders and deliver digital products.">
              <Button size="sm" label="Unlock" onPress={() => setUnlockOpen(true)} />
            </Notice>
          ) : null}
          {(data.store.paymentUris ?? []).length === 0 ? <Notice tone="warning" text="Add a payment method so buyers can pay you." /> : null}
          <View className="mt-4 flex-row flex-wrap gap-2">
            <Button size="sm" testID="store-manage-orders" label="Orders" onPress={() => router.push('/store/orders')} />
            <Button size="sm" variant="outline" testID="store-manage-edit" label="Edit store" onPress={() => router.push({ pathname: '/store/edit', params: { id: data.store?.id } })} />
            <Button size="sm" variant="outline" label="View as buyer" onPress={() => data.store && router.push(`/store/${data.store.id}`)} />
          </View>

          <Section title="Products" right={<Button size="sm" variant="ghost" testID="store-manage-add-item" label="Add" onPress={() => router.push('/store/product')} />}>
            {data.items.length === 0 ? <Text tone="secondary">No products yet. Add your first one.</Text> : null}
            {data.items.map((item) => (
              <Pressable key={item.id} accessibilityRole="button" testID={`manage-item-${item.id}`} onPress={() => router.push({ pathname: '/store/product', params: { id: item.id } })}>
                <Card className="gap-1 p-4">
                  <Text variant="bodyStrong">{item.title}</Text>
                  <Text tone="secondary">
                    {ITEM_STATUS[item.status]}
                    {item.basePrice !== undefined ? ` · ${price(item.basePrice, item.currency ?? data.store?.defaultCurrency)}` : ''}
                    {item.stockQuantity !== undefined ? ` · ${item.stockQuantity} in stock` : ''}
                    {item.fulfillment === 'digital' ? ' · Digital' : ''}
                  </Text>
                </Card>
              </Pressable>
            ))}
          </Section>

          <Section title="Shipping zones" right={<Button size="sm" variant="ghost" testID="store-manage-add-zone" label="Add" onPress={() => router.push('/store/zone')} />}>
            {data.zones.length === 0 ? <Text tone="secondary">No zones: physical products ship free, anywhere. Add zones to charge for shipping or limit where you ship.</Text> : null}
            {data.zones.map((zone) => (
              <Pressable key={zone.id} accessibilityRole="button" testID={`manage-zone-${zone.id}`} onPress={() => router.push({ pathname: '/store/zone', params: { id: zone.id } })}>
                <Card className="gap-1 p-4">
                  <Text variant="bodyStrong">{zone.name}</Text>
                  <Text tone="secondary">
                    {zone.countryPattern ? zone.countryPattern : 'Everywhere'}
                    {zone.rateType === 'flat' ? ` · ${zone.flatRate ? price(zone.flatRate, zone.currency ?? data.store?.defaultCurrency) : 'Free'}` : zone.rateType === 'weight_tiered' ? ' · By weight' : ' · By order total'}
                  </Text>
                </Card>
              </Pressable>
            ))}
          </Section>
        </ScrollView>
      )}
      <UnlockSheet open={unlockOpen} onClose={() => { setUnlockOpen(false); manage.refetch().catch(() => undefined); }} />
    </Screen>
  );
}
