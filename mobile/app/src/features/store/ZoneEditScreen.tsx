import type { ShippingPricingConfig, ShippingZone, Store } from '@engine/api';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useWrite } from '~/data/writes';
import { fromSmallestUnit, toSmallestUnit } from '~/lib-allowlist';
import { Button } from '~/ui/Button';
import { Card } from '~/ui/Card';
import { ErrorState } from '~/ui/EmptyState';
import { SegmentedControl } from '~/ui/Tabs';
import { Screen } from '~/ui/Screen';
import { SwitchRow } from '~/ui/Switch';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';

import { Loading, Notice, Section } from './parts';
import { saveZoneWrite } from './store-writes';
import { AmountField } from './VariantEditor';

type Unit = 'g' | 'oz' | 'lb' | 'kg';
interface Multiplier { upTo: number | undefined; percent: number | undefined }

/** Web `ShippingZoneModal`: where a zone ships, and its base rate, per-weight rate and order-total multipliers. */
export function ZoneEditScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const manage = useEngineQuery(queryKeys.store.manage(), (api) => api.store.manage());
  const store = manage.data?.store ?? null;
  const zone = id ? manage.data?.zones.find((candidate) => candidate.id === id) ?? null : null;
  if (!manage.data) return <Screen>{manage.isError ? <ErrorState message="Your store couldn't be loaded." onRetry={() => manage.refetch()} retrying={manage.isRetrying} /> : <Loading />}</Screen>;
  if (!store) return <Screen><ErrorState title="No store yet" message="Create your store first." /></Screen>;
  if (id && !zone) return <Screen><ErrorState title="Zone not found" message="It may have been deleted." /></Screen>;
  return <ZoneForm store={store} zone={zone} />;
}

const UNITS: readonly string[] = ['g', 'oz', 'lb', 'kg'];

function ZoneForm({ store, zone }: { store: Store; zone: ShippingZone | null }) {
  const save = useWrite(saveZoneWrite);
  const remove = useWrite(saveZoneWrite);
  const initialCurrency = zone?.currency ?? store.defaultCurrency ?? 'USD';
  const config = zone?.tiers && !Array.isArray(zone.tiers) ? (zone.tiers as ShippingPricingConfig) : null;
  const [name, setName] = useState(zone?.name ?? '');
  const [worldwide, setWorldwide] = useState(zone ? !zone.countryPattern : false);
  const [countries, setCountries] = useState(zone?.countryPattern ?? '');
  const [priority, setPriority] = useState<number | undefined>(zone?.priority ?? 0);
  const [currency, setCurrency] = useState(initialCurrency);
  const [base, setBase] = useState<number | undefined>(zone?.flatRate ? fromSmallestUnit(zone.flatRate, initialCurrency) : undefined);
  const [weightRate, setWeightRate] = useState<number | undefined>(config?.weightRate ? fromSmallestUnit(config.weightRate, initialCurrency) : undefined);
  const [unit, setUnit] = useState<Unit>(config?.weightUnit && UNITS.includes(config.weightUnit) ? (config.weightUnit as Unit) : 'lb');
  const [multipliers, setMultipliers] = useState<Multiplier[]>(
    (config?.subtotalMultipliers ?? []).map((m) => ({ upTo: m.upTo === null ? undefined : fromSmallestUnit(m.upTo, initialCurrency), percent: m.percent })),
  );

  useEffect(() => {
    if (save.status === 'confirmed' || remove.status === 'confirmed') router.back();
  }, [save.status, remove.status]);

  const submit = () => {
    const rate = weightRate ? toSmallestUnit(weightRate, currency) : 0;
    const steps = multipliers
      .filter((m) => m.percent !== undefined)
      .map((m) => ({ upTo: m.upTo === undefined ? null : toSmallestUnit(m.upTo, currency), percent: Math.trunc(m.percent ?? 100) }))
      .sort((a, b) => (a.upTo === null ? 1 : b.upTo === null ? -1 : a.upTo - b.upTo));
    const tiers: ShippingPricingConfig | undefined = rate > 0 || steps.length > 0
      ? { ...(rate > 0 ? { weightRate: rate, weightUnit: unit } : {}), ...(steps.length > 0 ? { subtotalMultipliers: steps } : {}) }
      : undefined;
    save.run({
      storeId: store.id,
      ...(zone ? { zoneId: zone.id, revision: zone.$revision } : {}),
      fields: {
        name,
        rateType: 'flat',
        flatRate: base ? toSmallestUnit(base, currency) : undefined,
        tiers,
        currency,
        countryPattern: worldwide ? undefined : countries.trim() || undefined,
        priority: Math.max(0, priority ?? 0),
      },
    }).catch(() => undefined);
  };

  const confirmDelete = () => {
    if (!zone) return;
    Alert.alert('Delete this zone?', 'Products limited to it no longer ship there.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { remove.run({ storeId: store.id, zoneId: zone.id, delete: true }).catch(() => undefined); } },
    ]);
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: zone ? 'Edit zone' : 'Add zone' }} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 64 }} keyboardShouldPersistTaps="handled" testID="zone-edit">
        <View className="gap-3">
          <TextField label="Zone name" value={name} onChangeText={setName} maxLength={100} placeholder="Domestic" testID="zone-name" />
          <SwitchRow label="Worldwide" value={worldwide} onValueChange={setWorldwide} testID="zone-worldwide" />
          {!worldwide ? <TextField label="Countries" value={countries} onChangeText={setCountries} autoCapitalize="characters" placeholder="US, CA or US.IL for a state" testID="zone-countries" /> : null}
          <AmountField label="Priority (lower matches first)" whole amount={priority} onAmount={setPriority} testID="zone-priority" />
          <TextField label="Currency" value={currency} onChangeText={setCurrency} autoCapitalize="characters" maxLength={5} testID="zone-currency" />
        </View>
        <Section title="Pricing">
          <AmountField label={`Base rate (${currency}, blank: free)`} amount={base} onAmount={setBase} testID="zone-base" />
          <AmountField label={`Rate per weight unit (${currency}, optional)`} amount={weightRate} onAmount={setWeightRate} testID="zone-weight-rate" />
          {weightRate ? (
            <SegmentedControl options={[{ value: 'g', label: 'g' }, { value: 'oz', label: 'oz' }, { value: 'lb', label: 'lb' }, { value: 'kg', label: 'kg' }]} value={unit} onChange={setUnit} />
          ) : null}
        </Section>
        <Section title="Order total discounts" right={<Button size="sm" variant="ghost" label="Add" onPress={() => setMultipliers((list) => [...list, { upTo: undefined, percent: 100 }])} />}>
          <Text tone="secondary">Charge a share of the rate by order total: 0 % above $100 is free shipping over $100.</Text>
          {multipliers.map((m, index) => (
            <Card key={index} className="flex-row items-end gap-2 p-3">
              <View className="flex-1"><AmountField label={`Up to (${currency}, blank: any)`} amount={m.upTo} onAmount={(upTo) => setMultipliers((list) => list.map((x, i) => (i === index ? { ...x, upTo } : x)))} /></View>
              <View className="flex-1"><AmountField label="Percent of rate" whole amount={m.percent} onAmount={(percent) => setMultipliers((list) => list.map((x, i) => (i === index ? { ...x, percent } : x)))} /></View>
              <Button size="sm" variant="ghost" label="Remove" onPress={() => setMultipliers((list) => list.filter((_, i) => i !== index))} />
            </Card>
          ))}
        </Section>
        {save.status === 'unconfirmed' ? <Notice tone="warning" text="Saved, awaiting network confirmation." /> : null}
        <Button className="mt-6" size="block" testID="zone-save" label={zone ? 'Save zone' : 'Add zone'} loading={save.status === 'pending'} disabled={!name.trim()} onPress={submit} />
        {zone ? <Button className="mt-3" size="block" variant="ghost" label="Delete zone" loading={remove.status === 'pending'} onPress={confirmDelete} /> : null}
      </ScrollView>
    </Screen>
  );
}
