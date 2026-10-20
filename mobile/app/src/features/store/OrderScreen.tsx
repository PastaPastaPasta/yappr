import type { BuyerOrderDTO, OrderStatus, SellerOrderDTO } from '@engine/api';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useWrite } from '~/data/writes';
import { UnlockSheet } from '~/features/messages/UnlockSheet';
import { formatOrderId } from '~/lib-allowlist';
import { Button } from '~/ui/Button';
import { Card } from '~/ui/Card';
import { ErrorState } from '~/ui/EmptyState';
import { RadioGroup } from '~/ui/RadioGroup';
import { Screen } from '~/ui/Screen';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';

import { AddressBlock, CopyRow, DeliveryList, FormScroll, Loading, Notice, openLink, OrderLines, Section, StatusDetail, useRefreshControl } from './parts';
import { orderStatusWrite } from './store-writes';

const STATUS_OPTIONS: { value: OrderStatus; title: string }[] = [
  { value: 'pending', title: 'Pending' },
  { value: 'payment_received', title: 'Payment received' },
  { value: 'processing', title: 'Processing' },
  { value: 'shipped', title: 'Shipped' },
  { value: 'delivered', title: 'Delivered' },
  { value: 'cancelled', title: 'Cancelled' },
  { value: 'refunded', title: 'Refunded' },
  { value: 'disputed', title: 'Disputed' },
];

/** One order, as its buyer (web `/orders` card) or its seller (web `/orders/seller` card). */
export function OrderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const order = useEngineQuery(queryKeys.store.order(id), (api) => api.store.order(id));
  const [unlockOpen, setUnlockOpen] = useState(false);
  const refreshControl = useRefreshControl(() => order.refetch());
  const data = order.data;
  return (
    <Screen>
      <Stack.Screen options={{ title: `Order #${formatOrderId(id)}` }} />
      {order.isPending ? <Loading /> : !data ? (
        <ErrorState message={order.error?.message ?? "This order couldn't be loaded."} onRetry={() => order.refetch()} retrying={order.isRetrying} />
      ) : (
        <FormScroll refreshControl={refreshControl} testID={`order-detail-${data.role}`}>
          {data.order.locked ? (
            <Notice tone="warning" text="Unlock your account on this device to see the order details.">
              <Button size="sm" label="Unlock" onPress={() => setUnlockOpen(true)} />
            </Notice>
          ) : null}
          {data.role === 'seller' ? <SellerOrder order={data.order} /> : <BuyerOrder order={data.order} />}
        </FormScroll>
      )}
      <UnlockSheet open={unlockOpen} onClose={() => { setUnlockOpen(false); order.refetch().catch(() => undefined); }} />
    </Screen>
  );
}

function Details({ order }: { order: BuyerOrderDTO | SellerOrderDTO }) {
  const payload = order.payload;
  if (!payload) return order.locked ? null : <Notice tone="warning" text="This order's details couldn't be read." />;
  return (
    <>
      <Section title="Items"><OrderLines payload={payload} showSku /></Section>
      {payload.shippingAddress ? <Section title="Shipping address"><AddressBlock address={payload.shippingAddress} /></Section> : null}
      {payload.buyerContact.email || payload.buyerContact.phone ? (
        <Section title="Contact">
          <Card className="p-4">
            {payload.buyerContact.email ? <Text selectable>{payload.buyerContact.email}</Text> : null}
            {payload.buyerContact.phone ? <Text selectable>{payload.buyerContact.phone}</Text> : null}
          </Card>
        </Section>
      ) : null}
      <Section title="Payment">
        <CopyRow label="Paid to" value={payload.paymentUri} />
        {payload.txid ? <CopyRow label="Transaction ID" value={payload.txid} /> : null}
        {payload.refundAddress ? <CopyRow label="Refund address" value={payload.refundAddress} /> : null}
      </Section>
      {payload.notes ? <Section title="Notes"><Text>{payload.notes}</Text></Section> : null}
    </>
  );
}

function BuyerOrder({ order }: { order: BuyerOrderDTO }) {
  return (
    <View>
      <Pressable accessibilityRole="link" onPress={() => router.push(`/store/${order.storeId}`)}>
        <Text variant="title">{order.storeName ?? 'Order'}</Text>
      </Pressable>
      <Text tone="secondary">Placed {order.createdAt.toLocaleString()}</Text>
      <Section title="Status"><StatusDetail status={order.status} /></Section>
      {order.digital || order.deliveries.length > 0 ? (
        <Section title="Digital delivery">
          {order.deliveries.length === 0 ? <Text tone="secondary">The seller hasn&apos;t delivered yet. Your files and codes appear here once they do.</Text> : <DeliveryList orderId={order.id} deliveries={order.deliveries} testID="order-deliveries" />}
        </Section>
      ) : null}
      <Details order={order} />
      <CopyRow label="Order ID" value={order.id} />
      {order.reviewed ? (
        <Text className="mt-6" tone="secondary">You reviewed this order. Thank you!</Text>
      ) : (
        <Button className="mt-6" size="block" variant="outline" label="Leave a review" testID="order-review" onPress={() => router.push(`/review/${order.id}`)} />
      )}
    </View>
  );
}

function SellerOrder({ order }: { order: SellerOrderDTO }) {
  const update = useWrite(orderStatusWrite);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<OrderStatus>(order.status?.status ?? 'pending');
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [message, setMessage] = useState('');
  const lastDelivery = order.deliveries[order.deliveries.length - 1];

  const save = () => {
    update.run({ orderId: order.id, status, trackingCarrier: carrier.trim() || undefined, trackingNumber: tracking.trim() || undefined, message: message.trim() || undefined })
      .then((ticket) => { if (ticket) setEditing(false); })
      .catch(() => undefined);
  };

  return (
    <View>
      <Pressable accessibilityRole="link" onPress={() => router.push(`/user/${order.buyerId}`)}>
        <Text variant="title">Order from {order.buyerName ? `@${order.buyerName}` : formatOrderId(order.buyerId)}</Text>
      </Pressable>
      <Text tone="secondary">Placed {order.createdAt.toLocaleString()}</Text>
      {order.paymentUrl ? (
        <Pressable accessibilityRole="link" onPress={() => order.paymentUrl && openLink(order.paymentUrl)} style={{ minHeight: 44, justifyContent: 'center' }}>
          <Text tone="link">Check the payment on the block explorer</Text>
        </Pressable>
      ) : null}

      {order.digital ? (
        <Section title="Digital delivery">
          {lastDelivery ? (
            <Text tone={lastDelivery.unconfirmed ? 'warning' : 'secondary'}>
              {lastDelivery.unconfirmed ? 'Sent, awaiting confirmation. Check before sending again.' : `Delivered ${lastDelivery.createdAt.toLocaleDateString()}`}
              {order.deliveries.length > 1 ? ` (${order.deliveries.length} deliveries)` : ''}
            </Text>
          ) : (
            <Text tone="secondary">
              {order.uncertain ? "Couldn't load this order's delivery state. Pull to refresh before delivering it." : 'Not delivered yet.'}
              {order.missingKits.length > 0 ? ` No saved delivery content for ${order.missingKits.join(', ')}: add links or codes when you deliver.` : ''}
            </Text>
          )}
          {order.deliveries.length > 0 ? <DeliveryList orderId={order.id} deliveries={order.deliveries} /> : null}
          <Button
            size="block"
            variant={lastDelivery ? 'outline' : 'primary'}
            testID="order-deliver"
            label={lastDelivery ? 'Send again' : 'Deliver now'}
            disabled={order.uncertain || order.locked}
            onPress={() => router.push({ pathname: '/store/deliver', params: { orderId: order.id } })}
          />
        </Section>
      ) : null}

      <Section title="Status">
        <StatusDetail status={order.status} />
        {editing ? (
          <View className="gap-3">
            <RadioGroup accessibilityLabel="Order status" options={STATUS_OPTIONS} value={status} onChange={setStatus} testID="order-status-options" />
            <TextField label="Carrier (optional)" value={carrier} onChangeText={setCarrier} testID="order-carrier" />
            <TextField label="Tracking number (optional)" value={tracking} onChangeText={setTracking} autoCapitalize="characters" testID="order-tracking" />
            <TextField label="Message to the buyer (optional)" value={message} onChangeText={setMessage} multiline testID="order-message" />
            <Button size="block" label="Save status" testID="order-status-save" loading={update.status === 'pending'} onPress={save} />
            <Button size="block" variant="ghost" label="Cancel" onPress={() => setEditing(false)} />
          </View>
        ) : (
          <Button size="block" variant="outline" label="Update status" testID="order-status-edit" onPress={() => { setStatus(order.status?.status ?? 'pending'); setEditing(true); }} />
        )}
        {update.status === 'unconfirmed' ? <Text tone="warning">Sent, awaiting confirmation.</Text> : null}
      </Section>
      <Details order={order} />
      <CopyRow label="Order ID" value={order.id} />
    </View>
  );
}
