import type { StoreItem, VariantCombination } from '@engine/api';
import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { requireAuth } from '~/data/require-auth';
import { useViewerId } from '~/data/session';
import { engine } from '~/engine';
import { queryClient } from '~/state/query-client';
import { Button } from '~/ui/Button';
import { ErrorState } from '~/ui/EmptyState';
import { useMediaUrls } from '~/ui/media-url';
import { Screen } from '~/ui/Screen';
import { Text } from '~/ui/Text';
import { toast } from '~/ui/toast';

import { errorText, Loading, price, reviewCount, ReviewsSection, Section, Stars } from './parts';
import { ReportLink } from './StoreReportScreen';

/** The combination with exactly these options, one per axis (`variantIdOf`: ids sorted, joined with "."). */
function combinationFor(item: StoreItem, selection: (number | undefined)[]): VariantCombination | undefined {
  if (!item.variants || selection.some((id) => id === undefined)) return undefined;
  const id = [...(selection as number[])].sort((a, b) => a - b).join('.');
  return item.variants.combinations.find((combination) => combination.id === id);
}

export function ItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const viewerId = useViewerId();
  const { media } = useMediaUrls();
  const item = useEngineQuery(queryKeys.store.item(id), (api) => api.store.item(id), { persist: true });
  const reviews = useEngineQuery(queryKeys.store.itemReviews(id), (api) => api.store.itemReviews(id));
  const value = item.data;
  const axes = value?.variants?.axes ?? [];
  const [selection, setSelection] = useState<(number | undefined)[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [adding, setAdding] = useState(false);
  const combination = value ? combinationFor(value, axes.map((_, index) => selection[index])) : undefined;
  const unitPrice = combination?.price ?? value?.basePrice;
  const stock = value?.variants ? combination?.stock : value?.stockQuantity;
  const soldOut = value?.status !== 'active' || stock === 0 || (value?.variants !== undefined && combination === undefined && selection.length === axes.length && axes.length > 0);
  const needsChoice = axes.length > 0 && !combination;
  const own = value !== undefined && value !== null && value.ownerId === viewerId;
  const average = useMemo(() => {
    const list = reviews.data?.reviews ?? [];
    return list.length > 0 ? list.reduce((sum, review) => sum + review.rating, 0) / list.length : null;
  }, [reviews.data]);

  const add = () =>
    requireAuth(() => {
      if (!value || adding) return;
      setAdding(true);
      engine.api.cart
        .add({ itemId: value.id, variantId: combination?.id ?? null, quantity })
        .then((cart) => {
          queryClient.setQueryData(queryKeys.store.cart(), cart);
          toast.success('Added to cart', { action: { label: 'View cart', onPress: () => router.push('/cart') } });
        })
        .catch((error: unknown) => toast.error(errorText(error, "Couldn't add this to your cart.")))
        .finally(() => setAdding(false));
    });

  if (item.isError) return <Screen><ErrorState message="This product couldn't be loaded." onRetry={() => item.refetch()} retrying={item.isRetrying} /></Screen>;
  if (!value) return <Screen>{item.isPending ? <Loading /> : <ErrorState title="Product not found" message="It may have been removed." />}</Screen>;

  return (
    <Screen>
      <Stack.Screen options={{ title: value.title }} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }} testID="store-item">
        {value.imageUrls?.length ? (
          <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false} className="-mx-4 mb-4">
            {value.imageUrls.map((url) => {
              const uri = media(url);
              return uri ? <Image key={url} source={{ uri }} style={{ width: 360, height: 280 }} contentFit="cover" accessibilityLabel={value.title} /> : null;
            })}
          </ScrollView>
        ) : null}
        <Text variant="title">{value.title}</Text>
        <Pressable accessibilityRole="link" onPress={() => router.push(`/store/${value.storeId}`)} style={{ minHeight: 32, justifyContent: 'center' }}>
          <Text tone="link">Visit store</Text>
        </Pressable>
        {average !== null ? <View className="flex-row items-center gap-2"><Stars rating={average} /><Text tone="secondary">{reviewCount(reviews.data?.reviews.length ?? 0)}</Text></View> : null}
        <Text variant="headline" className="mt-3" tabular>
          {unitPrice !== undefined ? price(unitPrice, value.currency) : 'Choose options for the price'}
        </Text>
        <Text tone="secondary" className="mt-1">
          {value.fulfillment === 'digital' ? 'Digital delivery: files and codes arrive in your orders.' : 'Shipped to your address.'}
          {stock !== undefined && stock > 0 ? ` ${stock} in stock.` : ''}
        </Text>
        {value.description ? <Text className="mt-3">{value.description}</Text> : null}

        {axes.map((axis, axisIndex) => (
          <Section key={axis.name} title={axis.name}>
            <View className="flex-row flex-wrap gap-2">
              {axis.options.map((option) => {
                const selected = selection[axisIndex] === option.id;
                return (
                  <Pressable
                    key={option.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    testID={`variant-${axisIndex}-${option.id}`}
                    onPress={() => setSelection((prev) => { const next = [...prev]; next[axisIndex] = option.id; return next; })}
                    className={selected ? 'rounded-full border-2 border-yappr-500 px-4 py-2' : 'rounded-full border border-gray-300 px-4 py-2 dark:border-gray-700'}
                    style={{ minHeight: 40 }}
                  >
                    <Text variant="subheadStrong">{option.name}</Text>
                  </Pressable>
                );
              })}
            </View>
          </Section>
        ))}

        {own ? (
          <Button className="mt-6" variant="outline" size="block" label="Edit this product" onPress={() => router.push({ pathname: '/store/product', params: { id: value.id } })} />
        ) : (
          <View className="mt-6 gap-3">
            <View className="flex-row items-center gap-4">
              <Button variant="outline" label="−" accessibilityLabel="Fewer" disabled={quantity <= 1} onPress={() => setQuantity((q) => Math.max(1, q - 1))} />
              <Text variant="headline" tabular accessibilityLabel={`Quantity ${quantity}`}>{quantity}</Text>
              <Button variant="outline" label="+" accessibilityLabel="More" disabled={stock !== undefined && quantity >= stock} onPress={() => setQuantity((q) => q + 1)} />
            </View>
            <Button
              size="block"
              testID="add-to-cart"
              label={soldOut ? 'Sold out' : needsChoice ? 'Choose options' : 'Add to cart'}
              disabled={soldOut || needsChoice}
              loading={adding}
              onPress={add}
            />
          </View>
        )}

        <ReviewsSection reviews={reviews.data?.reviews} failed={reviews.isError} onRetry={() => reviews.refetch()} />
        {!own ? <ReportLink target={{ docType: 'storeItem', targetId: value.id, ownerId: value.ownerId }} noun="product" /> : null}
      </ScrollView>
    </Screen>
  );
}
