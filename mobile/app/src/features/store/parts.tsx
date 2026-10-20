import type { DeliveryDTO, OrderPayload, OrderStatus, OrderStatusDTO } from '@engine/api';
import * as Clipboard from 'expo-clipboard';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as WebBrowser from 'expo-web-browser';
import { useState, type ReactNode } from 'react';
import { Pressable, RefreshControl, View } from 'react-native';

import { formatPrice } from '~/lib-allowlist';
import { engine } from '~/engine';
import { Button } from '~/ui/Button';
import { Card } from '~/ui/Card';
import { ErrorState } from '~/ui/EmptyState';
import { Screen } from '~/ui/Screen';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { safeExternalUrl } from '~/ui/media-url';
import { toast } from '~/ui/toast';

/** A price in its currency's smallest unit. */
export const price = (amount: number, currency = 'USD') => formatPrice(amount, currency);

/** The engine's own sentence for a refused call (it words its BAD_REQUESTs for the user), else `fallback`. */
export const errorText = (error: unknown, fallback: string): string => (error instanceof Error ? error.message : fallback);

/** `list` with the entry at `index` changed by `patch`: how the editors update one row of a list in state. */
export function patchAt<T extends object>(list: readonly T[], index: number, patch: Partial<T>): T[] {
  return list.map((entry, i) => (i === index ? { ...entry, ...patch } : entry));
}

interface ReviewLike {
  id: string;
  rating: number;
  title?: string;
  content?: string;
  createdAt: Date;
}

/** A store's or a product's reviews. */
export function ReviewsSection({ reviews }: { reviews: readonly ReviewLike[] | undefined }) {
  return (
    <Section title="Reviews">
      {(reviews ?? []).length === 0 ? <Text tone="secondary">No reviews yet.</Text> : null}
      {reviews?.map((review) => (
        <View key={review.id} className="gap-1 border-b border-gray-200 py-3 dark:border-gray-800">
          <Stars rating={review.rating} />
          {review.title ? <Text variant="bodyStrong">{review.title}</Text> : null}
          {review.content ? <Text>{review.content}</Text> : null}
          <Text variant="caption" tone="secondary">{review.createdAt.toLocaleDateString()}</Text>
        </View>
      ))}
    </Section>
  );
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <View className="mt-6 gap-2">
      <View className="flex-row items-center justify-between">
        <Text variant="headline">{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

/** A notice in a tinted card: `warning` for what stops the user, `info` for what to know. */
export function Notice({ text, tone = 'info', testID, children }: { text: string; tone?: 'info' | 'warning'; testID?: string; children?: ReactNode }) {
  return (
    <View
      testID={testID}
      accessibilityRole={tone === 'warning' ? 'alert' : undefined}
      className={tone === 'warning' ? 'mt-3 gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950' : 'mt-3 gap-3 rounded-lg border border-sky-200 bg-sky-50 p-3 dark:border-sky-800 dark:bg-sky-950'}
    >
      <Text variant="subhead" tone={tone === 'warning' ? 'warning' : 'primary'}>{text}</Text>
      {children}
    </View>
  );
}

export function Stars({ rating, size = 'subhead' }: { rating: number; size?: 'subhead' | 'headline' }) {
  const full = Math.round(rating);
  return (
    <Text variant={size} accessibilityLabel={`${rating.toFixed(1)} out of 5 stars`} className="text-amber-500">
      {'★'.repeat(full)}
      <Text variant={size} tone="decorative">{'★'.repeat(Math.max(0, 5 - full))}</Text>
    </Text>
  );
}

/** Five tappable stars (web `StarRatingInput`). */
export function StarInput({ value, onChange, label, testID }: { value: number; onChange: (rating: number) => void; label: string; testID?: string }) {
  return (
    <View className="flex-row gap-1" accessibilityLabel={label} testID={testID}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Pressable
          key={star}
          accessibilityRole="button"
          accessibilityLabel={`${star} star${star === 1 ? '' : 's'}`}
          accessibilityState={{ selected: value === star }}
          testID={testID ? `${testID}-${star}` : undefined}
          onPress={() => onChange(star)}
          hitSlop={6}
          style={{ minWidth: 40, minHeight: 40, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text variant="titleLarge" className={star <= value ? 'text-amber-500' : 'text-gray-300 dark:text-gray-600'}>★</Text>
        </Pressable>
      ))}
    </View>
  );
}

const STATUS_TONE: Partial<Record<OrderStatus, string>> = {
  delivered: 'bg-green-100 dark:bg-green-900',
  shipped: 'bg-blue-100 dark:bg-blue-900',
  cancelled: 'bg-gray-200 dark:bg-gray-800',
  refunded: 'bg-gray-200 dark:bg-gray-800',
  disputed: 'bg-red-100 dark:bg-red-900',
};

export function StatusPill({ status }: { status: OrderStatusDTO | null }) {
  return (
    <View className={`self-start rounded-full px-2.5 py-1 ${(status && STATUS_TONE[status.status]) ?? 'bg-amber-100 dark:bg-amber-900'}`}>
      <Text variant="captionStrong">{status?.label ?? 'Pending'}</Text>
    </View>
  );
}

const copy = (text: string, what: string) => {
  Clipboard.setStringAsync(text)
    .then(() => toast.success(`${what} copied`))
    .catch(() => toast.error(`Couldn't copy the ${what.toLowerCase()}`));
};

/** A seller-written link, through the app's guard (http(s) and IPFS only). */
export const openLink = (url: string) => {
  const safe = safeExternalUrl(url);
  if (!safe) {
    toast.error("This link can't be opened safely.");
    return;
  }
  WebBrowser.openBrowserAsync(safe).catch(() => toast.error("Couldn't open that link"));
};

/** Text the user may need to copy (a license key, an order id), shown monospace with a Copy button. */
export function CopyRow({ label, value, testID }: { label: string; value: string; testID?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Copy ${label}`}
      accessibilityHint={value}
      testID={testID}
      onPress={() => copy(value, label)}
      className="flex-row items-center justify-between gap-3 rounded-lg bg-gray-50 p-3 dark:bg-neutral-800"
      style={{ minHeight: 44 }}
    >
      <View className="flex-1">
        <Text variant="caption" tone="secondary">{label}</Text>
        <Text variant="subhead" selectable>{value}</Text>
      </View>
      <Text variant="subheadStrong" tone="link">Copy</Text>
    </Pressable>
  );
}

/** The order's lines and totals (web `OrderItemsList`). */
export function OrderLines({ payload, showSku = false }: { payload: OrderPayload; showSku?: boolean }) {
  return (
    <Card className="gap-2 p-4">
      {payload.items.map((line, index) => (
        <View key={`${line.itemId}-${line.variantId ?? ''}-${index}`} className="flex-row justify-between gap-3">
          <View className="flex-1">
            <Text variant="bodyStrong">{line.itemTitle}</Text>
            {line.variantLabel ? <Text variant="subhead" tone="secondary">{line.variantLabel}</Text> : null}
            {showSku && line.sku ? <Text variant="caption" tone="secondary">SKU {line.sku}</Text> : null}
            <Text variant="subhead" tone="secondary">
              {line.quantity} × {price(line.unitPrice, payload.currency)}
              {line.fulfillment === 'digital' ? ' · Digital' : ''}
            </Text>
          </View>
          <Text variant="bodyStrong" tabular>{price(line.unitPrice * line.quantity, payload.currency)}</Text>
        </View>
      ))}
      <View className="mt-2 gap-1 border-t border-gray-200 pt-2 dark:border-gray-800">
        <Totals subtotal={payload.subtotal} shipping={payload.shippingCost} total={payload.total} currency={payload.currency} />
      </View>
    </Card>
  );
}

export function Totals({ subtotal, shipping, total, currency }: { subtotal: number; shipping: number; total: number; currency: string }) {
  return (
    <>
      <View className="flex-row justify-between"><Text tone="secondary">Subtotal</Text><Text tabular>{price(subtotal, currency)}</Text></View>
      <View className="flex-row justify-between"><Text tone="secondary">Shipping</Text><Text tabular>{shipping > 0 ? price(shipping, currency) : 'Free'}</Text></View>
      <View className="flex-row justify-between"><Text variant="bodyStrong">Total</Text><Text variant="bodyStrong" tabular>{price(total, currency)}</Text></View>
    </>
  );
}

/** An order's latest status with its tracking (opened where it was sealed) and the seller's message. */
export function StatusDetail({ status }: { status: OrderStatusDTO | null }) {
  if (!status) return <Text tone="secondary">The seller hasn&apos;t updated this order yet.</Text>;
  return (
    <Card className="gap-1 p-4">
      <StatusPill status={status} />
      {status.trackingNumber ? (
        <Pressable
          accessibilityRole={status.trackingUrl ? 'link' : undefined}
          disabled={!status.trackingUrl}
          onPress={() => status.trackingUrl && openLink(status.trackingUrl)}
        >
          <Text className="mt-2" tone={status.trackingUrl ? 'link' : 'primary'}>
            Tracking: {status.trackingCarrier ? `${status.trackingCarrier} ` : ''}{status.trackingNumber}
          </Text>
        </Pressable>
      ) : null}
      {status.message ? <Text className="mt-1 italic">{status.message}</Text> : null}
    </Card>
  );
}

/** A file name the cache directory takes: no path separators or control characters. */
const safeFileName = (name: string) => name.replace(/[\\/:\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'download';

/** Decrypt a delivered file in the engine, write it to the cache, and hand it to the share sheet (save, open in…). */
function SaveFile({ orderId, deliveryId, itemIndex, assetIndex, name, size }: { orderId: string; deliveryId: string; itemIndex: number; assetIndex: number; name: string; size: number }) {
  const [busy, setBusy] = useState(false);
  const save = () => {
    setBusy(true);
    engine.api.store.deliveredFile({ orderId, deliveryId, itemIndex, assetIndex })
      .then(async (file) => {
        const target = new File(Paths.cache, safeFileName(file.name));
        if (target.exists) target.delete();
        target.create();
        target.write(file.base64, { encoding: 'base64' });
        await Sharing.shareAsync(target.uri, { dialogTitle: file.name });
      })
      .catch((error: unknown) => toast.error(errorText(error, "Couldn't save this file.")))
      .finally(() => setBusy(false));
  };
  return (
    <View className="flex-row items-center justify-between gap-3 rounded-lg bg-gray-50 p-3 dark:bg-neutral-800">
      <View className="flex-1">
        <Text variant="subheadStrong" numberOfLines={1}>{name}</Text>
        <Text variant="caption" tone="secondary">{size >= 1_048_576 ? `${(size / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`}</Text>
      </View>
      <Button size="sm" variant="outline" label="Save" loading={busy} onPress={save} accessibilityLabel={`Save ${name}`} />
    </View>
  );
}

/** What was delivered (web `DeliveryContents`): links open, codes and license keys copy, files save. */
export function DeliveryList({ orderId, deliveries, testID }: { orderId: string; deliveries: DeliveryDTO[]; testID?: string }) {
  return (
    <View className="gap-3" testID={testID}>
      {deliveries.map((delivery) => (
        <Card key={delivery.id} className="gap-2 p-4">
          <Text variant="caption" tone={delivery.unconfirmed ? 'warning' : 'secondary'}>
            {delivery.unconfirmed ? 'Sent, awaiting confirmation' : `Delivered ${delivery.createdAt.toLocaleDateString()}`}
          </Text>
          {!delivery.readable ? <Text tone="secondary">This delivery can&apos;t be read on this device. Unlock your encryption key to read it.</Text> : null}
          {delivery.message ? <Text className="italic">{delivery.message}</Text> : null}
          {delivery.items.map((item, index) => (
            <View key={`${delivery.id}-${index}`} className="gap-2">
              <Text variant="bodyStrong">{item.itemTitle}{item.variantLabel ? ` · ${item.variantLabel}` : ''}</Text>
              {item.assets.map((asset, assetIndex) => {
                const key = `${delivery.id}-${index}-${assetIndex}`;
                if (asset.kind === 'code') return <CopyRow key={key} label={asset.label} value={asset.code} />;
                if (asset.kind === 'link') {
                  return (
                    <View key={key} className="gap-2">
                      <Pressable accessibilityRole="link" onPress={() => openLink(asset.url)} style={{ minHeight: 44, justifyContent: 'center' }}>
                        <Text tone="link">{asset.label}</Text>
                      </Pressable>
                      {asset.code ? <CopyRow label={`${asset.label} code`} value={asset.code} /> : null}
                    </View>
                  );
                }
                return <SaveFile key={key} orderId={orderId} deliveryId={delivery.id} itemIndex={index} assetIndex={assetIndex} name={asset.name} size={asset.size} />;
              })}
              {item.licenseKeys?.map((code, keyIndex) => (
                <CopyRow key={`${delivery.id}-${index}-key-${keyIndex}`} label={`Code ${keyIndex + 1}`} value={code} testID={`delivered-code-${keyIndex}`} />
              ))}
              {item.instructions ? <Text tone="secondary">{item.instructions}</Text> : null}
            </View>
          ))}
        </Card>
      ))}
    </View>
  );
}

export function AddressBlock({ address }: { address: NonNullable<OrderPayload['shippingAddress']> }) {
  return (
    <Card className="gap-0.5 p-4">
      <Text variant="bodyStrong">{address.name}</Text>
      <Text tone="secondary">{address.street}</Text>
      <Text tone="secondary">{address.city}{address.state ? `, ${address.state}` : ''} {address.postalCode}</Text>
      <Text tone="secondary">{address.country}</Text>
    </Card>
  );
}

/** A list's pull to refresh: the spinner shows until `refetch` settles. */
export function useRefreshControl(refetch: () => Promise<unknown>) {
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = () => {
    setRefreshing(true);
    refetch().catch(() => undefined).finally(() => setRefreshing(false));
  };
  return <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />;
}

/** A centered spinner, while a screen's read is on its way. */
export function Loading() {
  return (
    <View className="items-center justify-center p-8" testID="store-loading">
      <Spinner size="md" />
    </View>
  );
}

/** What the seller's editors show until `store.manage()` has answered: a spinner, or the failure with a retry. */
export function ManageUnavailable({ failed, retrying, onRetry }: { failed: boolean; retrying?: boolean; onRetry: () => void }) {
  return (
    <Screen>
      {failed ? <ErrorState message="Your store couldn't be loaded." onRetry={onRetry} retrying={retrying} /> : <Loading />}
    </Screen>
  );
}
