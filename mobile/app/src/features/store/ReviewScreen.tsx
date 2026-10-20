import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useWrite } from '~/data/writes';
import { Button } from '~/ui/Button';
import { ErrorState } from '~/ui/EmptyState';
import { Screen } from '~/ui/Screen';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';

import { FormScroll, Loading, Notice, Section, StarInput } from './parts';
import { reviewWrite } from './store-writes';

const RATING_LABELS = ['Tap a star to rate', 'Poor', 'Fair', 'Good', 'Very good', 'Excellent'];

/** Web `ReviewModal`: rate the store for an order, and each item bought in it. */
export function ReviewScreen() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const order = useEngineQuery(queryKeys.store.order(orderId), (api) => api.store.order(orderId));
  const open = useEngineQuery(queryKeys.store.reviewsOpen(), (api) => api.store.reviewsOpen());
  const [rating, setRating] = useState(0);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [itemRatings, setItemRatings] = useState<Record<string, number>>({});
  const write = useWrite(reviewWrite);
  const buyerOrder = order.data?.role === 'buyer' ? order.data.order : null;
  const items = useMemo(
    () => Array.from(new Map((buyerOrder?.payload?.items ?? []).map((line) => [line.itemId, line.itemTitle])).entries()),
    [buyerOrder],
  );

  useEffect(() => {
    if (write.status === 'confirmed' || write.status === 'unconfirmed') router.back();
  }, [write.status]);

  if (order.isPending) return <Screen><Loading /></Screen>;
  if (!buyerOrder) return <Screen><ErrorState message="Only the buyer can review this order." /></Screen>;

  const submit = () => {
    write.run({
      orderId,
      rating,
      title: title.trim() || undefined,
      content: content.trim() || undefined,
      items: Object.entries(itemRatings).filter(([, value]) => value > 0).map(([itemId, value]) => ({ itemId, rating: value })),
    }).catch(() => undefined);
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Leave a review' }} />
      <FormScroll testID="review">
        <Text variant="title">{buyerOrder.storeName ?? 'This store'}</Text>
        {open.data === false ? <Notice tone="warning" text="Reviews aren't open yet. Check back soon." /> : null}
        <Section title="Your rating">
          <StarInput value={rating} onChange={setRating} label="Store rating" testID="review-stars" />
          <Text tone="secondary">{RATING_LABELS[rating]}</Text>
        </Section>
        <Section title="Your review (optional)">
          <TextField label="Title" value={title} onChangeText={setTitle} maxLength={100} testID="review-title" />
          <TextField label="What was it like?" value={content} onChangeText={setContent} multiline maxLength={1000} testID="review-content" />
        </Section>
        {items.length > 0 ? (
          <Section title="Rate what you bought (optional)">
            {items.map(([itemId, itemTitle]) => (
              <View key={itemId} className="gap-1">
                <Text variant="bodyStrong">{itemTitle}</Text>
                <StarInput value={itemRatings[itemId] ?? 0} onChange={(value) => setItemRatings((prev) => ({ ...prev, [itemId]: value }))} label={`Rating for ${itemTitle}`} testID={`review-item-${itemId}`} />
              </View>
            ))}
          </Section>
        ) : null}
        <Text variant="caption" tone="secondary" className="mt-4">Reviews are public.</Text>
        <Button className="mt-4" size="block" label="Post review" testID="review-submit" disabled={rating < 1 || open.data === false} loading={write.status === 'pending'} onPress={submit} />
      </FormScroll>
    </Screen>
  );
}
