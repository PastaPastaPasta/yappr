import type { CartDTO, CartLineDTO } from '@engine/api';
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { requireAuth } from '~/data/require-auth';
import { engine } from '~/engine';
import { queryClient } from '~/state/query-client';
import { Button } from '~/ui/Button';
import { Card } from '~/ui/Card';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { Screen } from '~/ui/Screen';
import { Text } from '~/ui/Text';
import { toast } from '~/ui/toast';

import { errorText, Loading, Notice, price } from './parts';

/** The device's cart (web `/cart`): one section per store, each checked out on its own. */
export function CartScreen() {
  const cart = useEngineQuery(queryKeys.store.cart(), (api) => api.cart.get());
  const [busy, setBusy] = useState<string | null>(null);

  const change = (line: CartLineDTO, call: () => Promise<CartDTO>) => {
    setBusy(line.key);
    call()
      .then((next) => queryClient.setQueryData(queryKeys.store.cart(), next))
      .catch((error: unknown) => toast.error(errorText(error, "Couldn't update your cart.")))
      .finally(() => setBusy(null));
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Cart' }} />
      {cart.isPending ? <Loading /> : cart.isError ? (
        <ErrorState message="Your cart couldn't be loaded." onRetry={() => cart.refetch()} retrying={cart.isRetrying} />
      ) : !cart.data || cart.data.stores.length === 0 ? (
        <EmptyState title="Your cart is empty" description="Products you add from a store show up here." action={{ label: 'Browse stores', onPress: () => router.push('/store') }} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }} testID="cart">
          {cart.data.stores.map((section) => (
            <View key={section.storeId} className="mb-6 gap-3">
              <Text variant="headline">{section.storeName ?? 'Store'}</Text>
              {section.lines.map((line) => (
                <Card key={line.key} className="gap-2 p-4" testID={`cart-line-${line.itemId}`}>
                  <Text variant="bodyStrong">{line.title}</Text>
                  {line.variantLabel ? <Text tone="secondary">{line.variantLabel}</Text> : null}
                  <Text tone="secondary">{price(line.unitPrice, line.currency)} each{line.digital ? ' · Digital' : ''}</Text>
                  <View className="flex-row items-center gap-3">
                    <Button size="sm" variant="outline" label="−" accessibilityLabel={`Fewer ${line.title}`} disabled={busy !== null} onPress={() => change(line, () => engine.api.cart.setQuantity(line.key, line.quantity - 1))} />
                    <Text variant="bodyStrong" tabular accessibilityLabel={`Quantity ${line.quantity}`}>{line.quantity}</Text>
                    <Button size="sm" variant="outline" label="+" accessibilityLabel={`More ${line.title}`} disabled={busy !== null} onPress={() => change(line, () => engine.api.cart.setQuantity(line.key, line.quantity + 1))} />
                    <View className="flex-1" />
                    <Button size="sm" variant="ghost" label="Remove" disabled={busy !== null} onPress={() => change(line, () => engine.api.cart.remove(line.key))} />
                  </View>
                </Card>
              ))}
              {section.currency === null ? (
                <Notice tone="warning" text="These items are priced in different currencies, so they can't be paid for together. Remove some to check out." />
              ) : (
                <View className="flex-row items-center justify-between">
                  <Text variant="bodyStrong">Subtotal</Text>
                  <Text variant="bodyStrong" tabular>{price(section.subtotal, section.currency)}</Text>
                </View>
              )}
              <Button
                size="block"
                testID={`checkout-${section.storeId}`}
                label="Check out"
                disabled={section.currency === null}
                onPress={() => requireAuth(() => router.push({ pathname: '/checkout/[storeId]', params: { storeId: section.storeId } }))}
              />
            </View>
          ))}
        </ScrollView>
      )}
    </Screen>
  );
}
