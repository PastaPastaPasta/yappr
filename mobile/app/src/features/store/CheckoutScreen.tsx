import type { BuyerContact, CheckoutQuoteDTO, ShippingAddress } from '@engine/api';
import * as Clipboard from 'expo-clipboard';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Linking, ScrollView, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useWrite } from '~/data/writes';
import { UnlockSheet } from '~/features/messages/UnlockSheet';
import { Button } from '~/ui/Button';
import { Card } from '~/ui/Card';
import { ErrorState } from '~/ui/EmptyState';
import { RadioGroup } from '~/ui/RadioGroup';
import { Screen } from '~/ui/Screen';
import { SwitchRow } from '~/ui/Switch';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';
import { toast } from '~/ui/toast';

import { Loading, Notice, price, Section, Totals } from './parts';
import { placeOrderWrite } from './store-writes';

type Step = 'details' | 'policies' | 'payment';

const EMPTY_ADDRESS: ShippingAddress = { name: '', street: '', city: '', state: '', postalCode: '', country: 'US' };

const addressComplete = (a: ShippingAddress) => Boolean(a.name.trim() && a.street.trim() && a.city.trim() && a.postalCode.trim() && /^[A-Za-z]{2}$/.test(a.country.trim()));

/**
 * Web `/checkout` for one store's cart: details (address and contact),
 * the store's policies, then payment. The order is encrypted to the seller
 * in the engine with the buyer's key, so both can read it.
 */
export function CheckoutScreen() {
  const { storeId } = useLocalSearchParams<{ storeId: string }>();
  const [step, setStep] = useState<Step>('details');
  const [ship, setShip] = useState(false);
  const [address, setAddress] = useState<ShippingAddress>(EMPTY_ADDRESS);
  const [contact, setContact] = useState<BuyerContact>({});
  // The address the quote was last asked for: the quote follows Continue, not each keystroke.
  const [asked, setAsked] = useState<ShippingAddress | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [paymentUri, setPaymentUri] = useState('');
  const [txid, setTxid] = useState('');
  const [refundAddress, setRefundAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [unlockOpen, setUnlockOpen] = useState(false);
  const place = useWrite(placeOrderWrite);

  const quote = useEngineQuery(
    queryKeys.store.checkout(storeId, asked),
    (api) => api.store.checkout({ storeId, shipTo: asked, contact }),
    { staleTime: 0, gcTime: 0 },
  );
  const q = quote.data;
  // The store's first payment method until the buyer picks one.
  const chosenUri = paymentUri || q?.store.paymentUris[0]?.uri || '';

  const placed = place.status === 'confirmed' || place.status === 'unconfirmed';
  const placing = place.status === 'pending';

  if (placed) return <Placed confirmed={place.status === 'confirmed'} digital={(q?.digitalCount ?? 0) > 0} />;
  if (quote.isPending && !q) return <Screen><Stack.Screen options={{ title: 'Checkout' }} /><Loading /></Screen>;
  if (!q) return <Screen><Stack.Screen options={{ title: 'Checkout' }} /><ErrorState message={quote.error?.message ?? "Checkout couldn't be loaded."} onRetry={() => quote.refetch()} retrying={quote.isRetrying} /></Screen>;

  const needsAddress = ship && !q.digitalOnly;
  const shippingReady = !needsAddress || (asked !== null && q.shipping.state === 'ok' && !quote.isFetching);

  const continueDetails = () => {
    if (needsAddress) {
      if (!addressComplete(address)) {
        toast.error('Fill in the address, with a two-letter country code (US, DE, …).');
        return;
      }
      setAsked({ ...address });
    } else {
      setAsked(null);
    }
    setStep('policies');
  };

  const continuePolicies = () => {
    quote.refetch().then(({ data }) => {
      if (!data) return;
      if (data.blocker === 'missing-buyer-key') setUnlockOpen(true);
      else if (!data.blocker && !data.orderSizeError && data.unavailable.length === 0) setStep('payment');
    }).catch(() => undefined);
  };

  const submit = () => {
    if (!chosenUri || placing) return;
    place.run({
      storeId,
      shipTo: needsAddress ? asked : null,
      contact,
      paymentUri: chosenUri,
      txid: txid.trim() || undefined,
      refundAddress: refundAddress.trim() || undefined,
      notes: notes.trim() || undefined,
      reviewed: { lines: q.lines.map((line) => ({ key: line.key, quantity: line.quantity, digital: line.digital })), shippingCost: q.shipping.cost },
    }).catch(() => undefined);
  };

  const back = step === 'payment' ? () => setStep('policies') : step === 'policies' ? () => setStep('details') : null;
  const currency = q.currency ?? 'USD';

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Checkout' }} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 64 }} keyboardShouldPersistTaps="handled" testID={`checkout-${step}`}>
        <Text tone="secondary">{q.store.name} · Step {step === 'details' ? 1 : step === 'policies' ? 2 : 3} of 3</Text>
        {q.unavailable.length > 0 ? (
          <Notice tone="warning" text={q.unavailable.map((line) => `${line.title}: ${line.reason}`).join(' ')}>
            <Button size="sm" variant="outline" label="Check availability again" loading={quote.isFetching} onPress={() => quote.refetch()} />
          </Notice>
        ) : null}
        {q.blocker && q.blocker !== 'missing-buyer-key' ? <Notice tone="warning" text={q.blockerMessage ?? ''} testID="checkout-blocker" /> : null}
        {q.orderSizeError ? <Notice tone="warning" text={q.orderSizeError} /> : null}

        {step === 'details' ? (
          <View>
            {q.digitalCount > 0 ? (
              <Notice text={`${q.digitalOnly ? 'Everything in this order is digital, so no shipping address is needed.' : `${q.digitalCount} digital item${q.digitalCount === 1 ? ' is' : 's are'} delivered online; only the rest ships.`} The seller delivers your files and keys encrypted to you; find them under My Orders.`} />
            ) : null}
            {!q.digitalOnly ? (
              <View className="mt-4">
                <SwitchRow label="Ship to an address" description="Turn off to arrange delivery with the seller." value={ship} onValueChange={setShip} testID="checkout-ship" />
              </View>
            ) : null}
            {needsAddress ? (
              <Section title="Shipping address">
                <TextField label="Full name" value={address.name} onChangeText={(name) => setAddress((a) => ({ ...a, name }))} autoComplete="name" testID="addr-name" />
                <TextField label="Street" value={address.street} onChangeText={(street) => setAddress((a) => ({ ...a, street }))} autoComplete="street-address" testID="addr-street" />
                <TextField label="City" value={address.city} onChangeText={(city) => setAddress((a) => ({ ...a, city }))} testID="addr-city" />
                <TextField label="State or region" value={address.state ?? ''} onChangeText={(state) => setAddress((a) => ({ ...a, state }))} testID="addr-state" />
                <TextField label="Postal code" value={address.postalCode} onChangeText={(postalCode) => setAddress((a) => ({ ...a, postalCode }))} autoComplete="postal-code" testID="addr-postal" />
                <TextField label="Country code" value={address.country} onChangeText={(country) => setAddress((a) => ({ ...a, country }))} autoCapitalize="characters" maxLength={2} testID="addr-country" />
              </Section>
            ) : null}
            <Section title="Contact (optional)">
              <TextField label="Email" value={contact.email ?? ''} onChangeText={(email) => setContact((c) => ({ ...c, email }))} keyboardType="email-address" autoCapitalize="none" testID="contact-email" />
              <TextField label="Phone" value={contact.phone ?? ''} onChangeText={(phone) => setContact((c) => ({ ...c, phone }))} keyboardType="phone-pad" testID="contact-phone" />
            </Section>
            <Button className="mt-6" size="block" label="Continue" testID="checkout-continue" onPress={continueDetails} />
          </View>
        ) : null}

        {step === 'policies' ? (
          <View>
            {needsAddress ? <ShippingSummary q={q} fetching={quote.isFetching} /> : null}
            <Section title="Store policies">
              {q.store.policies.length === 0 ? <Text tone="secondary">This store has no policies to agree to.</Text> : null}
              {q.store.policies.map((policy, index) => (
                <Card key={`${policy.name}-${index}`} className="gap-1 p-4">
                  <Text variant="bodyStrong">{policy.name}</Text>
                  <Text tone="secondary">{policy.content}</Text>
                </Card>
              ))}
              {q.store.policies.length > 0 ? <SwitchRow label="I agree to these policies" value={agreed} onValueChange={setAgreed} testID="checkout-agree" /> : null}
            </Section>
            <Button
              className="mt-6"
              size="block"
              label="Continue to payment"
              testID="checkout-to-payment"
              loading={quote.isFetching}
              disabled={(q.store.policies.length > 0 && !agreed) || !shippingReady || q.unavailable.length > 0 || Boolean(q.orderSizeError) || (q.blocker !== null && q.blocker !== 'missing-buyer-key')}
              onPress={continuePolicies}
            />
            {q.blocker === 'missing-buyer-key' ? <Notice tone="warning" text="Your order is encrypted with your encryption key. Unlock it on this device to continue." /> : null}
          </View>
        ) : null}

        {step === 'payment' ? (
          <Payment
            q={q}
            currency={currency}
            paymentUri={chosenUri}
            onPaymentUri={setPaymentUri}
            txid={txid}
            onTxid={setTxid}
            refundAddress={refundAddress}
            onRefundAddress={setRefundAddress}
            notes={notes}
            onNotes={setNotes}
            placing={placing}
            failed={place.status === 'failed'}
            onPlace={submit}
          />
        ) : null}
        {back ? <Button className="mt-3" variant="ghost" size="block" label="Back" disabled={placing} onPress={back} /> : null}
      </ScrollView>
      <UnlockSheet open={unlockOpen} onClose={() => { setUnlockOpen(false); continuePolicies(); }} />
    </Screen>
  );
}

function ShippingSummary({ q, fetching }: { q: CheckoutQuoteDTO; fetching: boolean }) {
  if (fetching) return <Text className="mt-4" tone="secondary">Calculating shipping…</Text>;
  if (q.shipping.state === 'problem') return <Notice tone="warning" text={q.shipping.problem ?? "We can't ship to this address."} testID="checkout-shipping-problem" />;
  return (
    <Card className="mt-4 gap-1 p-4">
      <Text variant="bodyStrong">Shipping: {q.shipping.cost > 0 ? price(q.shipping.cost, q.currency ?? 'USD') : 'Free'}</Text>
      {q.shipping.shipments.map((shipment) => (
        <Text key={shipment.zone} tone="secondary">{shipment.zone}: {shipment.titles.join(', ')}</Text>
      ))}
    </Card>
  );
}

interface PaymentProps {
  q: CheckoutQuoteDTO;
  currency: string;
  paymentUri: string;
  onPaymentUri: (uri: string) => void;
  txid: string;
  onTxid: (value: string) => void;
  refundAddress: string;
  onRefundAddress: (value: string) => void;
  notes: string;
  onNotes: (value: string) => void;
  placing: boolean;
  failed: boolean;
  onPlace: () => void;
}

/** Web `PaymentSelector`, `OrderReview` and the notes: pay the seller directly, then place the order. */
function Payment(props: PaymentProps) {
  const { q, currency, paymentUri } = props;
  const limits = q.paymentFieldLimits;
  const options = useMemo(() => q.store.paymentUris.map((payment) => ({ value: payment.uri, title: payment.label || payment.scheme.replace(/:$/, '').toUpperCase(), description: payment.uri })), [q.store.paymentUris]);
  const open = () => {
    Linking.openURL(paymentUri).catch(() => toast.error('No wallet on this device opens this payment link. Copy it instead.'));
  };
  return (
    <View>
      <Section title="Pay the seller">
        <Text tone="secondary">Send {price(q.total, currency)} with one of the store&apos;s payment methods, then place your order. Payment goes straight to the seller.</Text>
        <RadioGroup accessibilityLabel="Payment method" options={options} value={paymentUri} onChange={props.onPaymentUri} testID="checkout-payment-method" />
        {paymentUri ? (
          <View className="items-center gap-3 py-2">
            <View className="rounded-lg bg-white p-3"><QRCode value={paymentUri} size={180} /></View>
            <View className="flex-row gap-2">
              <Button variant="outline" size="sm" label="Open in wallet" onPress={open} />
              <Button variant="outline" size="sm" label="Copy address" onPress={() => { Clipboard.setStringAsync(paymentUri).then(() => toast.success('Payment address copied')).catch(() => undefined); }} />
            </View>
          </View>
        ) : null}
        <TextField label="Transaction ID (optional)" value={props.txid} onChangeText={props.onTxid} autoCapitalize="none" maxLength={limits?.txid} testID="checkout-txid" />
        <TextField label="Refund address (optional)" value={props.refundAddress} onChangeText={props.onRefundAddress} autoCapitalize="none" maxLength={limits?.refundAddress} testID="checkout-refund" />
      </Section>
      <Section title="Your order">
        <Card className="gap-2 p-4">
          {q.lines.map((line) => (
            <View key={line.key} className="flex-row justify-between gap-3">
              <Text className="flex-1">{line.quantity} × {line.title}{line.variantLabel ? ` (${line.variantLabel})` : ''}</Text>
              <Text tabular>{price(line.unitPrice * line.quantity, currency)}</Text>
            </View>
          ))}
          <View className="mt-2 gap-1 border-t border-gray-200 pt-2 dark:border-gray-800">
            <Totals subtotal={q.subtotal} shipping={q.shipping.cost} total={q.total} currency={currency} />
          </View>
        </Card>
        <TextField label="Order notes (optional)" value={props.notes} onChangeText={props.onNotes} multiline maxLength={limits?.notes} testID="checkout-notes" />
      </Section>
      <Button className="mt-6" size="block" label={props.placing ? 'Placing order…' : 'Place order'} testID="checkout-place" loading={props.placing} disabled={!paymentUri} onPress={props.onPlace} />
      <Text variant="caption" tone="secondary" className="mt-2 text-center">Your order details are encrypted and sent securely to the seller.</Text>
    </View>
  );
}

function Placed({ confirmed, digital }: { confirmed: boolean; digital: boolean }) {
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Order placed', headerBackVisible: false }} />
      <View className="flex-1 items-center justify-center gap-3 p-8" testID="checkout-placed">
        <Text variant="titleLarge">{confirmed ? 'Order placed!' : 'Order sent'}</Text>
        <Text tone="secondary" className="text-center">
          {confirmed ? 'Your order has been sent to the seller. They will process it and post updates.' : 'Your order was sent and is awaiting network confirmation. It shows in your orders once it lands.'}
          {digital ? ' Your digital items appear in My Orders as soon as the seller delivers them.' : ''}
        </Text>
        <View className="mt-4 flex-row gap-3">
          <Button variant="outline" label="View orders" onPress={() => router.replace('/orders')} />
          <Button label="Keep shopping" onPress={() => router.replace('/store')} />
        </View>
      </View>
    </Screen>
  );
}
