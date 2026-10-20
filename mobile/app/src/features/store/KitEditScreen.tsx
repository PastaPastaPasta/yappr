import type { KitDTO } from '@engine/api';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { engine } from '~/engine';
import { UnlockSheet } from '~/features/messages/UnlockSheet';
import { queryClient } from '~/state/query-client';
import { Button } from '~/ui/Button';
import { Card } from '~/ui/Card';
import { ErrorState } from '~/ui/EmptyState';
import { RadioGroup } from '~/ui/RadioGroup';
import { Screen } from '~/ui/Screen';
import { SwitchRow } from '~/ui/Switch';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';
import { toast } from '~/ui/toast';

import { Loading, Notice, Section } from './parts';

const EMPTY: KitDTO = { instructions: '', files: [], links: [], codes: [], licenseKeys: null, deliverWhen: 'payment_confirmed' };

/**
 * Web `DigitalKitEditor`: what a digital product delivers. Encrypted to the
 * seller's own key on chain; each delivery is encrypted to its buyer.
 */
export function KitEditScreen() {
  const { itemId } = useLocalSearchParams<{ itemId: string }>();
  const read = useEngineQuery(queryKeys.store.kit(itemId), (api) => api.store.kit(itemId), { staleTime: 0, gcTime: 0 });
  const [unlockOpen, setUnlockOpen] = useState(false);

  if (read.isPending) return <Screen><Loading /></Screen>;
  if (read.isError) return <Screen><ErrorState message="The delivery content couldn't be loaded." onRetry={() => read.refetch()} retrying={read.isRetrying} /></Screen>;
  if (read.data?.locked) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Delivery content' }} />
        <View className="p-4">
          <Notice tone="warning" text="Delivery content is encrypted to your encryption key. Unlock it on this device to edit it.">
            <Button size="sm" label="Unlock" onPress={() => setUnlockOpen(true)} />
          </Notice>
        </View>
        <UnlockSheet open={unlockOpen} onClose={() => { setUnlockOpen(false); read.refetch().catch(() => undefined); }} />
      </Screen>
    );
  }
  const loaded = read.data && !read.data.locked ? read.data : null;
  return <KitForm itemId={itemId} initial={loaded?.kit ?? EMPTY} revision={loaded?.revision ?? null} />;
}

function KitForm({ itemId, initial, revision }: { itemId: string; initial: KitDTO; revision: number | null }) {
  const [kit, setKit] = useState<KitDTO>(initial);
  const [keysText, setKeysText] = useState((initial.licenseKeys ?? []).join('\n'));
  const [saving, setSaving] = useState(false);
  const sellsCodes = kit.licenseKeys !== null;
  const update = (patch: Partial<KitDTO>) => setKit({ ...kit, ...patch });
  const submit = () => {
    if (saving) return;
    setSaving(true);
    const toSave: KitDTO = { ...kit, licenseKeys: sellsCodes ? keysText.split('\n').map((line) => line.trim()).filter(Boolean) : null };
    engine.api.store.saveKit(itemId, toSave, revision)
      .then((saved) => {
        queryClient.invalidateQueries({ queryKey: queryKeys.store.kit(itemId) }).catch(() => undefined);
        queryClient.invalidateQueries({ queryKey: queryKeys.store.sellerOrders() }).catch(() => undefined);
        toast.success('Delivery content saved');
        router.back();
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Couldn't save the delivery content."))
      .finally(() => setSaving(false));
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Delivery content' }} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 64 }} keyboardShouldPersistTaps="handled" testID="kit-edit">
        <Text tone="secondary">What every buyer of this product receives. It is encrypted so only you can read it here; each delivery is encrypted to its buyer.</Text>
        <Section title="When to deliver">
          <RadioGroup
            accessibilityLabel="When orders can be delivered in bulk"
            value={kit.deliverWhen}
            onChange={(deliverWhen) => update({ deliverWhen })}
            options={[
              { value: 'payment_confirmed', title: 'After I confirm payment', description: '"Deliver all" waits for Payment received.' },
              { value: 'on_order', title: 'As soon as it is ordered', description: '"Deliver all" sends it straight away.' },
            ]}
            testID="kit-when"
          />
        </Section>
        <Section title="Links" right={<Button size="sm" variant="ghost" label="Add" testID="kit-add-link" onPress={() => update({ links: [...kit.links, { label: '', url: '' }] })} />}>
          {kit.links.map((link, index) => (
            <Card key={index} className="gap-2 p-3">
              <TextField label="Label" value={link.label} onChangeText={(label) => update({ links: kit.links.map((l, i) => (i === index ? { ...l, label } : l)) })} testID={`kit-link-label-${index}`} />
              <TextField label="URL" value={link.url} onChangeText={(url) => update({ links: kit.links.map((l, i) => (i === index ? { ...l, url } : l)) })} autoCapitalize="none" autoCorrect={false} keyboardType="url" testID={`kit-link-url-${index}`} />
              <TextField label="Access code (optional)" value={link.code ?? ''} onChangeText={(code) => update({ links: kit.links.map((l, i) => (i === index ? { ...l, code } : l)) })} autoCapitalize="none" autoCorrect={false} />
              <Button size="sm" variant="ghost" label="Remove link" onPress={() => update({ links: kit.links.filter((_, i) => i !== index) })} />
            </Card>
          ))}
        </Section>
        <Section title="Codes" right={<Button size="sm" variant="ghost" label="Add" onPress={() => update({ codes: [...kit.codes, { label: '', code: '' }] })} />}>
          <Text tone="secondary">The same code for every buyer (a password, a voucher).</Text>
          {kit.codes.map((code, index) => (
            <Card key={index} className="gap-2 p-3">
              <TextField label="Label" value={code.label} onChangeText={(label) => update({ codes: kit.codes.map((c, i) => (i === index ? { ...c, label } : c)) })} />
              <TextField label="Code" value={code.code} onChangeText={(value) => update({ codes: kit.codes.map((c, i) => (i === index ? { ...c, code: value } : c)) })} autoCapitalize="none" autoCorrect={false} />
              <Button size="sm" variant="ghost" label="Remove code" onPress={() => update({ codes: kit.codes.filter((_, i) => i !== index) })} />
            </Card>
          ))}
        </Section>
        <Section title="Unique codes">
          <SwitchRow label="Sell unique codes" description="License keys or single-use links: one per unit sold, taken from this list." value={sellsCodes} onValueChange={(on) => update({ licenseKeys: on ? [] : null })} testID="kit-unique" />
          {sellsCodes ? <TextField label="One per line" value={keysText} onChangeText={setKeysText} multiline autoCapitalize="none" autoCorrect={false} testID="kit-keys" /> : null}
          {sellsCodes ? <Text tone="secondary">{keysText.split('\n').filter((line) => line.trim()).length} left</Text> : null}
        </Section>
        <Section title="Instructions">
          <TextField label="How to use it (optional)" value={kit.instructions} onChangeText={(instructions) => update({ instructions })} multiline maxLength={2000} testID="kit-instructions" />
        </Section>
        {kit.files.length > 0 ? (
          <Section title="Files">
            {kit.files.map((file) => <Text key={file.name} tone="secondary">{file.name} (kept as uploaded)</Text>)}
          </Section>
        ) : null}
        <Button className="mt-6" size="block" testID="kit-save" label="Save delivery content" loading={saving} onPress={submit} />
      </ScrollView>
    </Screen>
  );
}
