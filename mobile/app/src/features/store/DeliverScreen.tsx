import type { DeliverInput } from '@engine/api';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { errorCode } from '~/data/writes';
import { engine } from '~/engine';
import { queryClient } from '~/state/query-client';
import { Button } from '~/ui/Button';
import { Card } from '~/ui/Card';
import { ErrorState } from '~/ui/EmptyState';
import { Screen } from '~/ui/Screen';
import { SwitchRow } from '~/ui/Switch';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';
import { toast } from '~/ui/toast';

import { Loading, Notice, Section } from './parts';

type Extra = NonNullable<DeliverInput['extras']>[string][number];

/**
 * Web `DeliverDigitalModal`: deliver an order's digital lines from each
 * product's delivery content, plus links or codes for this order only and a
 * message. Worked out from the order's receipts as just read; nothing is
 * sent until every blocker is gone and any warning was checked.
 */
export function DeliverScreen() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const plan = useEngineQuery(queryKeys.store.deliveryPlan(orderId), (api) => api.store.deliveryPlan(orderId), { staleTime: 0, gcTime: 0 });
  const [selected, setSelected] = useState<number[] | null>(null);
  const [message, setMessage] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [extras, setExtras] = useState<Record<string, Extra[]>>({});
  const [busy, setBusy] = useState(false);
  const data = plan.data;

  if (plan.isPending) return <Screen><Loading /></Screen>;
  if (!data) return <Screen><ErrorState message={plan.error?.message ?? "This order's delivery couldn't be worked out."} onRetry={() => plan.refetch()} retrying={plan.isRetrying} /></Screen>;
  const chosen = selected ?? data.selected;

  const deliver = () => {
    if (busy) return;
    setBusy(true);
    engine.api.store.deliver({ orderId, lines: chosen, message: message.trim() || undefined, extras, acknowledged })
      .then((result) => {
        queryClient.invalidateQueries({ queryKey: queryKeys.store.orders() }).catch(() => undefined);
        // Unique codes out of their pools are recorded nowhere else: the alert stays until dismissed.
        if (result.recoveryText) Alert.alert('Check these unique codes', result.recoveryText);
        if (result.error) {
          Alert.alert('Not delivered', result.error);
          plan.refetch().catch(() => undefined);
          return;
        }
        toast.success(result.pending ? 'Sent, awaiting confirmation' : 'Delivered');
        for (const warning of result.warnings) toast.error(warning);
        router.back();
      })
      .catch((error: unknown) => {
        // A deadline or restart cut the call short; the engine may still be delivering.
        const cutShort = ['ENGINE_TIMEOUT', 'ENGINE_RESTARTED'].includes(errorCode(error) ?? '');
        Alert.alert(
          cutShort ? 'Still delivering?' : 'Not delivered',
          cutShort ? 'This is taking longer than expected. The delivery may still go out: check the order before sending again.' : error instanceof Error ? error.message : "Couldn't deliver this order.",
        );
        plan.refetch().catch(() => undefined);
      })
      .finally(() => setBusy(false));
  };

  // Extras belong to the product: every line of it (each variant) gets them.
  const addExtra = (itemId: string, kind: Extra['kind']) =>
    setExtras((prev) => ({ ...prev, [itemId]: [...(prev[itemId] ?? []), kind === 'link' ? { kind: 'link', label: 'Download', url: '' } : { kind: 'code', label: 'Code', code: '' }] }));
  const setExtra = (itemId: string, index: number, patch: Partial<Extra>) =>
    setExtras((prev) => ({ ...prev, [itemId]: (prev[itemId] ?? []).map((extra, i) => (i === index ? ({ ...extra, ...patch } as Extra) : extra)) }));

  return (
    <Screen>
      <Stack.Screen options={{ title: data.previousDeliveries > 0 ? 'Send again' : 'Deliver' }} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 64 }} keyboardShouldPersistTaps="handled" testID="deliver">
        <Text tone="secondary">Encrypted so only this buyer can read it. It appears in their orders and library.</Text>
        {data.lines.map((line) => {
          const on = chosen.includes(line.index);
          const lineExtras = extras[line.itemId] ?? [];
          return (
            <Card key={line.index} className="mt-3 gap-2 p-4">
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                disabled={data.lines.length < 2}
                onPress={() => setSelected(on ? chosen.filter((i) => i !== line.index) : [...chosen, line.index])}
                style={{ minHeight: 32 }}
              >
                <Text variant="bodyStrong">{data.lines.length > 1 ? (on ? '☑ ' : '☐ ') : ''}{line.itemTitle}{line.variantLabel ? ` · ${line.variantLabel}` : ''} × {line.quantity}</Text>
              </Pressable>
              {line.sentBefore ? <Text tone="warning">Delivered before.</Text> : null}
              {line.sellsCodes ? <Text tone="secondary">{line.codesOwed} unique code{line.codesOwed === 1 ? '' : 's'} to send</Text> : null}
              {line.contents.length > 0 ? <Text tone="secondary">Sends: {line.contents.join(', ')}</Text> : <Text tone="warning">No saved delivery content. Add a link or code for this order.</Text>}
              {lineExtras.map((extra, extraIndex) => (
                <View key={extraIndex} className="gap-2">
                  <TextField
                    label="Label"
                    value={extra.label}
                    onChangeText={(label) => setExtra(line.itemId, extraIndex, { label })}
                  />
                  {extra.kind === 'link' ? (
                    <TextField label="URL" value={extra.url} autoCapitalize="none" autoCorrect={false} keyboardType="url" onChangeText={(url) => setExtra(line.itemId, extraIndex, { url })} />
                  ) : (
                    <TextField label="Code" value={extra.code} autoCapitalize="none" autoCorrect={false} onChangeText={(code) => setExtra(line.itemId, extraIndex, { code })} />
                  )}
                </View>
              ))}
              <View className="flex-row gap-2">
                <Button size="sm" variant="ghost" label="Add link" onPress={() => addExtra(line.itemId, 'link')} />
                <Button size="sm" variant="ghost" label="Add code" onPress={() => addExtra(line.itemId, 'code')} />
              </View>
            </Card>
          );
        })}
        {data.blockers.length > 0 ? <Notice tone="warning" text={data.blockers.join(' ')} testID="deliver-blockers" /> : null}
        {data.warnings.length > 0 ? (
          <Notice tone="warning" text={data.warnings.join(' ')}>
            <SwitchRow label="I checked these lines" value={acknowledged} onValueChange={setAcknowledged} />
          </Notice>
        ) : null}
        <Section title="Message (optional)">
          <TextField label="A note for the buyer" value={message} onChangeText={setMessage} multiline maxLength={1000} testID="deliver-message" />
        </Section>
        {data.marksDelivered ? <Text className="mt-3" tone="secondary">This delivery completes the order, so it is marked Delivered once it confirms.</Text> : null}
        <Button
          className="mt-6"
          size="block"
          testID="deliver-send"
          label="Deliver"
          loading={busy}
          disabled={chosen.length === 0 || (data.warnings.length > 0 && !acknowledged)}
          onPress={deliver}
        />
      </ScrollView>
    </Screen>
  );
}
