import type { ItemVariants, Store, StoreItem, StoreItemStatus, StoreManageDTO } from '@engine/api';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useWrite } from '~/data/writes';
import { fromSmallestUnit, toSmallestUnit } from '~/lib-allowlist';
import { Button } from '~/ui/Button';
import { ErrorState } from '~/ui/EmptyState';
import { RadioGroup } from '~/ui/RadioGroup';
import { Screen } from '~/ui/Screen';
import { SwitchRow } from '~/ui/Switch';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';

import { ManageUnavailable, Notice, Section } from './parts';
import { saveItemWrite } from './store-writes';
import { AmountField, emptyVariants, VariantEditor } from './VariantEditor';

type EditableStatus = Exclude<StoreItemStatus, 'deleted'>;

const STATUSES: { value: EditableStatus; title: string }[] = [
  { value: 'active', title: 'Active' },
  { value: 'paused', title: 'Paused' },
  { value: 'sold_out', title: 'Sold out' },
];

/** Web `/store/item/add` and the product editor on `/store/manage`. */
export function ProductEditScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const manage = useEngineQuery(queryKeys.store.manage(), (api) => api.store.manage());
  const store = manage.data?.store ?? null;
  const item = id ? manage.data?.items.find((candidate) => candidate.id === id) ?? null : null;
  if (!manage.data) return <ManageUnavailable failed={manage.isError} retrying={manage.isRetrying} onRetry={() => manage.refetch()} />;
  if (!store) return <Screen><ErrorState title="No store yet" message="Create your store before adding products." /></Screen>;
  if (id && !item) return <Screen><ErrorState title="Product not found" message="It may have been removed." /></Screen>;
  return <ProductForm manage={manage.data} store={store} item={item} />;
}

function ProductForm({ manage, store, item }: { manage: StoreManageDTO; store: Store; item: StoreItem | null }) {
  const id = item?.id;
  const save = useWrite(saveItemWrite);
  const archive = useWrite(saveItemWrite);
  const initialCurrency = item?.currency ?? store.defaultCurrency ?? 'USD';
  const [title, setTitle] = useState(item?.title ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [currency, setCurrency] = useState(initialCurrency);
  const [amount, setAmount] = useState<number | undefined>(item?.basePrice === undefined ? undefined : fromSmallestUnit(item.basePrice, initialCurrency));
  const [stock, setStock] = useState<number | undefined>(item?.stockQuantity);
  const [sku, setSku] = useState(item?.sku ?? '');
  const [weight, setWeight] = useState<number | undefined>(item?.weight);
  const [images, setImages] = useState((item?.imageUrls ?? []).join('\n'));
  const [status, setStatus] = useState<EditableStatus>(!item || item.status === 'deleted' ? 'active' : item.status);
  const [digital, setDigital] = useState(item?.fulfillment === 'digital');
  const [zones, setZones] = useState<string[] | null>(item?.shippingZoneIds?.length ? item.shippingZoneIds : null);
  // The listing's revision when this draft was made: the save is refused if it moved since (another editor).
  const [revision] = useState(item?.$revision);
  // A saved options table keeps its option ids for carts, orders and kits: it can be edited, not removed here.
  const [savedOptions] = useState(Boolean(item?.variants?.combinations.length));
  const [withOptions, setWithOptions] = useState(savedOptions);
  const [variants, setVariants] = useState<ItemVariants>(item?.variants ?? emptyVariants());

  useEffect(() => {
    if (save.status === 'confirmed' && !id) router.back();
    if (archive.status === 'confirmed') router.back();
  }, [save.status, archive.status, id]);

  const supportsDigital = manage.supportsDigital;
  const zoneList = manage.zones;
  const submit = () => {
    save.run({
      storeId: store.id,
      ...(item ? { itemId: item.id, revision } : {}),
      fields: {
        title, description, currency, status, sku,
        basePrice: amount === undefined ? undefined : toSmallestUnit(amount, currency),
        stockQuantity: stock,
        weight,
        imageUrls: images.split(/\s+/).filter(Boolean),
        fulfillment: digital ? 'digital' : 'shipped',
        shippingZoneIds: digital ? undefined : zones ?? undefined,
        ...(withOptions ? { variants } : {}),
      },
    }).catch(() => undefined);
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: item ? 'Edit product' : 'Add product' }} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 64 }} keyboardShouldPersistTaps="handled" testID="product-edit">
        <View className="gap-3">
          <TextField label="Title" value={title} onChangeText={setTitle} maxLength={200} testID="product-title" />
          <TextField label="Description" value={description} onChangeText={setDescription} multiline maxLength={5000} testID="product-description" />
          <TextField label="Image links, one per line (https:// or ipfs://)" value={images} onChangeText={setImages} multiline autoCapitalize="none" autoCorrect={false} testID="product-images" />
          <TextField label="Currency" value={currency} onChangeText={setCurrency} autoCapitalize="characters" autoCorrect={false} maxLength={5} testID="product-currency" />
          {!withOptions ? (
            <>
              <AmountField label={`Price (${currency})`} amount={amount} onAmount={setAmount} testID="product-price" />
              <AmountField label="Stock (blank: not tracked)" whole amount={stock} onAmount={setStock} testID="product-stock" />
            </>
          ) : null}
          <TextField label="SKU (optional)" value={sku} onChangeText={setSku} autoCapitalize="characters" autoCorrect={false} testID="product-sku" />
        </View>

        <Section title="Status">
          <RadioGroup accessibilityLabel="Product status" options={STATUSES} value={status} onChange={setStatus} testID="product-status" />
        </Section>

        <Section title="Delivery">
          {supportsDigital ? (
            <SwitchRow label="Digital product" description="Links, codes or files delivered to the buyer. Nothing ships." value={digital} onValueChange={setDigital} testID="product-digital" />
          ) : null}
          {digital && item ? (
            <Button variant="outline" size="block" testID="product-kit" label="Delivery content" onPress={() => router.push({ pathname: '/store/kit', params: { itemId: item.id } })} />
          ) : null}
          {digital && !item ? <Text tone="secondary">Save the product, then add what buyers receive under Delivery content.</Text> : null}
          {!digital ? <AmountField label="Weight in grams (optional, for weight-based shipping)" whole amount={weight} onAmount={setWeight} testID="product-weight" /> : null}
          {!digital && manage.supportsItemZones && zoneList.length > 0 ? (
            <View className="gap-2">
              <SwitchRow label="Ships under every zone" value={zones === null} onValueChange={(all) => setZones(all ? null : [])} testID="product-all-zones" />
              {zones !== null ? zoneList.map((zone) => {
                const on = zones.includes(zone.id);
                return (
                  <Pressable key={zone.id} accessibilityRole="checkbox" accessibilityState={{ checked: on }} onPress={() => setZones(on ? zones.filter((z) => z !== zone.id) : [...zones, zone.id])} style={{ minHeight: 44, justifyContent: 'center' }}>
                    <Text>{on ? '☑' : '☐'} {zone.name}</Text>
                  </Pressable>
                );
              }) : null}
              {zones !== null && zones.length === 0 ? <Notice tone="warning" text="Choose at least one zone, or let it ship under every zone." /> : null}
            </View>
          ) : null}
        </Section>

        <Section title="Options">
          {savedOptions ? null : <SwitchRow label="This product has options" description="Sizes, colors and the like, each with its own price and stock." value={withOptions} onValueChange={setWithOptions} testID="product-options" />}
          {withOptions ? <VariantEditor variants={variants} currency={currency} defaultPrice={amount === undefined ? variants.combinations[0]?.price ?? 0 : toSmallestUnit(amount, currency)} onChange={setVariants} /> : null}
        </Section>

        {save.status === 'unconfirmed' ? <Notice tone="warning" text="Saved, awaiting network confirmation." /> : null}
        {save.status === 'confirmed' && item ? <Notice text="Saved." /> : null}
        <Button className="mt-6" size="block" testID="product-save" label={item ? 'Save product' : 'Add product'} loading={save.status === 'pending'} disabled={!title.trim() || (zones !== null && zones.length === 0 && !digital) || (!item && save.status === 'unconfirmed')} onPress={submit} />
        {item ? (
          <Button
            className="mt-3"
            size="block"
            variant="ghost"
            label="Remove product"
            loading={archive.status === 'pending'}
            onPress={() =>
              Alert.alert('Remove this product?', 'Buyers can no longer see or order it. Its orders and reviews stay.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Remove', style: 'destructive', onPress: () => { archive.run({ storeId: store.id, itemId: item.id, archive: true }).catch(() => undefined); } },
              ])
            }
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}
