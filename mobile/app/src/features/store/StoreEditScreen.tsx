import type { StoreManageDTO, StorePolicy, StoreStatus } from '@engine/api';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useLandingIntent, useWrite } from '~/data/writes';
import { Button } from '~/ui/Button';
import { Card } from '~/ui/Card';
import { RadioGroup } from '~/ui/RadioGroup';
import { Screen } from '~/ui/Screen';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';

import { ManageUnavailable, Notice, patchAt, Section } from './parts';
import { saveStoreWrite, STORE_CREATE_KEY } from './store-writes';

const STATUSES: { value: StoreStatus; title: string; description: string }[] = [
  { value: 'active', title: 'Open', description: 'Buyers can browse and order.' },
  { value: 'paused', title: 'Paused', description: 'Visible, but not taking orders.' },
  { value: 'closed', title: 'Closed', description: 'Not taking orders.' },
];

/** Web `/store/create` and the store settings on `/store/manage`. */
export function StoreEditScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const manage = useEngineQuery(queryKeys.store.manage(), (api) => api.store.manage());
  if (!manage.data) return <ManageUnavailable failed={manage.isError} retrying={manage.isRetrying} onRetry={() => manage.refetch()} />;
  return <StoreForm manage={manage.data} edit={Boolean(id)} />;
}

function StoreForm({ manage, edit }: { manage: StoreManageDTO; edit: boolean }) {
  const store = edit ? manage.store : null;
  const editing = store !== null;
  const save = useWrite(saveStoreWrite);
  // A create that may still land (this form's or an earlier one): a second tap would make a second store.
  const creating = useLandingIntent(STORE_CREATE_KEY) !== undefined;
  // The revision this draft was read at, frozen with it: the save is refused if the store moved since.
  const [revision] = useState(store?.$revision);
  const [name, setName] = useState(store?.name ?? '');
  const [description, setDescription] = useState(store?.description ?? '');
  const [category, setCategory] = useState(store?.category ?? '');
  const [status, setStatus] = useState<StoreStatus>(store?.status ?? 'active');
  const [currency, setCurrency] = useState(store?.defaultCurrency ?? 'USD');
  const [location, setLocation] = useState(store?.location ?? '');
  const [payments, setPayments] = useState<string[]>(store?.paymentUris?.length ? store.paymentUris.map((payment) => payment.uri) : ['']);
  const [policies, setPolicies] = useState<StorePolicy[]>(store ? manage.policies : []);

  useEffect(() => {
    if (save.status === 'confirmed') router.back();
  }, [save.status]);

  const submit = () => {
    save.run({
      ...(editing && store ? { storeId: store.id, revision } : {}),
      fields: {
        name, description, category, status, defaultCurrency: currency, location,
        paymentUris: payments.filter((uri) => uri.trim()),
        policies,
      },
    }).catch(() => undefined);
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: editing ? 'Edit store' : 'Create store' }} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 64 }} keyboardShouldPersistTaps="handled" testID="store-edit">
        <View className="gap-3">
          <TextField label="Store name" value={name} onChangeText={setName} maxLength={100} testID="store-name" />
          <TextField label="Description" value={description} onChangeText={setDescription} multiline maxLength={1000} testID="store-description" />
          <TextField
            label={manage.categoryRequired ? 'Category' : 'Category (optional)'}
            value={category}
            onChangeText={setCategory}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={20}
            placeholder="e.g. art, books, clothing"
            testID="store-category"
          />
          <TextField label="Default currency" value={currency} onChangeText={setCurrency} autoCapitalize="characters" autoCorrect={false} maxLength={5} testID="store-currency" />
          <TextField label="Location (optional)" value={location} onChangeText={setLocation} maxLength={100} testID="store-location" />
        </View>
        {editing ? (
          <Section title="Status">
            <RadioGroup accessibilityLabel="Store status" options={STATUSES} value={status} onChange={setStatus} testID="store-status" />
          </Section>
        ) : null}
        <Section title="Payment methods" right={<Button size="sm" variant="ghost" label="Add" onPress={() => setPayments((list) => [...list, ''])} />}>
          <Text tone="secondary">Buyers pay you directly. Paste a payment address from your wallet, like dash:… or bitcoin:….</Text>
          {payments.map((uri, index) => (
            <View key={index} className="flex-row items-end gap-2">
              <View className="flex-1">
                <TextField label={`Payment ${index + 1}`} value={uri} onChangeText={(text) => setPayments((list) => list.map((value, i) => (i === index ? text : value)))} autoCapitalize="none" autoCorrect={false} testID={`store-payment-${index}`} />
              </View>
              {payments.length > 1 ? <Button size="sm" variant="ghost" label="Remove" onPress={() => setPayments((list) => list.filter((_, i) => i !== index))} /> : null}
            </View>
          ))}
        </Section>
        <Section title="Policies" right={<Button size="sm" variant="ghost" label="Add" onPress={() => setPolicies((list) => [...list, { name: '', content: '' }])} />}>
          {policies.length === 0 ? <Text tone="secondary">Returns, shipping times, refunds: buyers agree to these at checkout.</Text> : null}
          {policies.map((policy, index) => (
            <Card key={index} className="gap-2 p-3">
              <TextField label="Policy" value={policy.name} onChangeText={(text) => setPolicies((list) => patchAt(list, index, { name: text }))} placeholder="Return policy" />
              <TextField label="Details" value={policy.content} onChangeText={(text) => setPolicies((list) => patchAt(list, index, { content: text }))} multiline />
              <Button size="sm" variant="ghost" label="Remove policy" onPress={() => setPolicies((list) => list.filter((_, i) => i !== index))} />
            </Card>
          ))}
        </Section>
        {save.status === 'unconfirmed' ? <Notice tone="warning" text="Saved, awaiting network confirmation." /> : null}
        <Button className="mt-6" size="block" testID="store-save" label={editing ? 'Save store' : 'Create store'} loading={save.status === 'pending'} disabled={!name.trim() || (!editing && creating)} onPress={submit} />
      </ScrollView>
    </Screen>
  );
}
