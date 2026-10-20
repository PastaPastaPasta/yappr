import type { ItemVariants, VariantCombination } from '@engine/api';
import { useState } from 'react';
import { View } from 'react-native';

import { fromSmallestUnit, toSmallestUnit } from '~/lib-allowlist';
import { Button } from '~/ui/Button';
import { Card } from '~/ui/Card';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';

/*
 * These edits follow lib/storefront/variant-codec.ts (addOption, removeOption,
 * renameOption, addAxis), which the app cannot import: it reads lib/constants
 * through storefront-contract (src/lib-allowlist.ts). The engine re-checks
 * every table it saves with lib's `variantProblems`.
 */

/** The contract's option ids run 1–254 and are never reused (`ItemVariants.nextOptionId`). */
const MAX_OPTION_ID = 254;
/** Storefront v7+ `prices` maxItems: a grid past it is refused before it is built. */
const MAX_COMBINATIONS = 256;

const combinationId = (optionIds: readonly number[]) => [...optionIds].sort((a, b) => a - b).join('.');

export const emptyVariants = (): ItemVariants => ({ axes: [], combinations: [], nextOptionId: 1 });

/** Every way to pick one id from each list (lib's `product`), refused past the combination cap. */
function grid(lists: number[][]): number[][] {
  if (lists.reduce((size, list) => size * list.length, 1) > MAX_COMBINATIONS) throw new Error(`A product can offer at most ${MAX_COMBINATIONS} combinations.`);
  return lists.reduce<number[][]>((rows, list) => rows.flatMap((row) => list.map((value) => [...row, value])), [[]]);
}

/** Rename one option, by its id: every combination, cart line and kit target naming it keeps naming it. */
export function renameOption(variants: ItemVariants, optionId: number, name: string): ItemVariants {
  return { ...variants, axes: variants.axes.map((axis) => ({ ...axis, options: axis.options.map((option) => (option.id === optionId ? { ...option, name } : option)) })) };
}

/**
 * Add a choice to an axis with a fresh id. It is offered with every pattern of
 * the other axes the table already offers, so combinations the seller removed
 * stay removed; with none offered, it comes with every pattern.
 */
export function addOption(variants: ItemVariants, axisIndex: number, name: string, price: number): ItemVariants {
  const id = variants.nextOptionId;
  if (id > MAX_OPTION_ID) throw new Error('This product has used up its option ids. Create a new product for more options.');
  const axes = variants.axes.map((axis, index) => (index === axisIndex ? { ...axis, options: [...axis.options, { id, name }] } : axis));
  const patterns = new Map<string, number[]>();
  for (const combination of variants.combinations) {
    const optionIds = combination.optionIds.map((optionId, index) => (index === axisIndex ? id : optionId));
    patterns.set(combinationId(optionIds), optionIds);
  }
  if (patterns.size === 0) {
    for (const optionIds of grid(axes.map((axis, index) => (index === axisIndex ? [id] : axis.options.map((option) => option.id))))) patterns.set(combinationId(optionIds), optionIds);
  }
  const added = [...patterns.values()].map((optionIds) => ({ id: combinationId(optionIds), optionIds, price }));
  if (variants.combinations.length + added.length > MAX_COMBINATIONS) throw new Error(`A product can offer at most ${MAX_COMBINATIONS} combinations.`);
  return { axes, combinations: [...variants.combinations, ...added], nextOptionId: id + 1 };
}

/**
 * Remove a choice and its combinations. Only for choices not yet saved: saved
 * ids may be named by carts and orders. An axis's last choice takes the axis
 * with it: combinations that differed only there merge into the first.
 */
export function removeOption(variants: ItemVariants, optionId: number): ItemVariants {
  const axisIndex = variants.axes.findIndex((axis) => axis.options.some((option) => option.id === optionId));
  if (axisIndex < 0) return variants;
  if (variants.axes[axisIndex].options.length > 1) {
    return {
      ...variants,
      axes: variants.axes.map((axis) => ({ ...axis, options: axis.options.filter((option) => option.id !== optionId) })),
      combinations: variants.combinations.filter((combination) => !combination.optionIds.includes(optionId)),
    };
  }
  const axes = variants.axes.filter((_, index) => index !== axisIndex);
  if (axes.length === 0) return { ...emptyVariants(), nextOptionId: variants.nextOptionId };
  const merged = new Map<string, VariantCombination>();
  for (const combination of variants.combinations) {
    const optionIds = combination.optionIds.filter((_, index) => index !== axisIndex);
    const id = combinationId(optionIds);
    if (!merged.has(id)) merged.set(id, { ...combination, id, optionIds });
  }
  return { ...variants, axes, combinations: [...merged.values()] };
}

/** Add an axis with one choice (only on a table not saved yet: every saved combination would change). */
export function addAxis(variants: ItemVariants, name: string, choice: string, price: number): ItemVariants {
  const id = variants.nextOptionId;
  if (id > MAX_OPTION_ID) throw new Error('This product has used up its option ids. Create a new product for more options.');
  const axes = [...variants.axes, { name, options: [{ id, name: choice }] }];
  const combinations = variants.axes.length === 0
    ? [{ id: String(id), optionIds: [id], price }]
    : variants.combinations.map((combination) => ({ ...combination, id: combinationId([...combination.optionIds, id]), optionIds: [...combination.optionIds, id] }));
  return { axes, combinations, nextOptionId: id + 1 };
}

/**
 * Combination photos follow their image when the gallery changes: `image` is a
 * 1-based gallery position, so each is re-pointed by URL (cleared when its
 * image was removed).
 */
export function remapVariantImages(variants: ItemVariants, before: readonly string[], after: readonly string[]): ItemVariants {
  return {
    ...variants,
    combinations: variants.combinations.map((combination) => {
      if (combination.image === undefined) return combination;
      const index = after.indexOf(before[combination.image - 1] ?? '');
      const next: VariantCombination = { ...combination };
      if (index >= 0) next.image = index + 1;
      else delete next.image;
      return next;
    }),
  };
}

/** Re-express every combination price in `to` (web `convertPrices`): prices are in each currency's smallest unit. */
export function convertVariantPrices(variants: ItemVariants, from: string, to: string): ItemVariants {
  return { ...variants, combinations: variants.combinations.map((combination) => ({ ...combination, price: toSmallestUnit(fromSmallestUnit(combination.price, from), to) })) };
}

/**
 * Options (web `VariantEditor`), id-stable: options are renamed in place and
 * choices are added with fresh ids; a saved choice is never removed or
 * reassigned (carts, orders and delivery kits name it by id). Combinations
 * the seller removed elsewhere stay removed: only a new choice adds any.
 */
export function VariantEditor({ variants, savedIds, currency, defaultPrice, onChange }: {
  variants: ItemVariants;
  /** Option ids already stored on chain. */
  savedIds: ReadonlySet<number>;
  currency: string;
  defaultPrice: number;
  onChange: (next: ItemVariants) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [newChoice, setNewChoice] = useState<Record<number, string>>({});
  const [newAxis, setNewAxis] = useState({ name: '', choice: '' });
  const apply = (change: () => ItemVariants) => {
    try {
      onChange(change());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'These options could not be used.');
    }
  };
  const optionName = (id: number) => variants.axes.flatMap((axis) => axis.options).find((option) => option.id === id)?.name ?? '?';
  const setCombination = (id: string, patch: Partial<VariantCombination>) =>
    onChange({ ...variants, combinations: variants.combinations.map((combination) => (combination.id === id ? { ...combination, ...patch } : combination)) });
  const tableSaved = savedIds.size > 0;

  return (
    <View className="gap-3" testID="variant-editor">
      {variants.axes.map((axis, axisIndex) => (
        <Card key={axis.options[0]?.id ?? axisIndex} className="gap-2 p-3">
          <TextField
            label="Option name"
            value={axis.name}
            onChangeText={(name) => onChange({ ...variants, axes: variants.axes.map((a, i) => (i === axisIndex ? { ...a, name } : a)) })}
            testID={`variant-axis-${axisIndex}`}
          />
          {axis.options.map((option) => (
            <View key={option.id} className="flex-row items-end gap-2">
              <View className="flex-1">
                <TextField label="Choice" value={option.name} onChangeText={(name) => onChange(renameOption(variants, option.id, name))} />
              </View>
              {savedIds.has(option.id) ? null : <Button size="sm" variant="ghost" label="Remove" onPress={() => apply(() => removeOption(variants, option.id))} />}
            </View>
          ))}
          <View className="flex-row items-end gap-2">
            <View className="flex-1">
              <TextField label="New choice" value={newChoice[axisIndex] ?? ''} placeholder="XL" onChangeText={(text) => setNewChoice((prev) => ({ ...prev, [axisIndex]: text }))} testID={`variant-new-${axisIndex}`} />
            </View>
            <Button
              size="sm"
              variant="outline"
              label="Add"
              disabled={!(newChoice[axisIndex] ?? '').trim()}
              onPress={() => {
                apply(() => addOption(variants, axisIndex, (newChoice[axisIndex] ?? '').trim(), defaultPrice));
                setNewChoice((prev) => ({ ...prev, [axisIndex]: '' }));
              }}
            />
          </View>
        </Card>
      ))}
      {!tableSaved && variants.axes.length < 3 ? (
        <Card className="gap-2 p-3">
          <TextField label="Add an option" value={newAxis.name} placeholder="Size" onChangeText={(name) => setNewAxis((prev) => ({ ...prev, name }))} testID="variant-add-axis" />
          <TextField label="First choice" value={newAxis.choice} placeholder="M" onChangeText={(choice) => setNewAxis((prev) => ({ ...prev, choice }))} testID="variant-add-axis-choice" />
          <Button
            size="sm"
            variant="outline"
            label="Add option"
            disabled={!newAxis.name.trim() || !newAxis.choice.trim()}
            onPress={() => {
              apply(() => addAxis(variants, newAxis.name.trim(), newAxis.choice.trim(), defaultPrice));
              setNewAxis({ name: '', choice: '' });
            }}
          />
        </Card>
      ) : null}
      {error ? <Text tone="error">{error}</Text> : null}
      {variants.combinations.map((combination) => (
        <View key={combination.id} className="gap-1">
          <Text variant="bodyStrong">{combination.optionIds.map(optionName).join(' / ')}</Text>
          <View className="flex-row gap-2">
            <View className="flex-1">
              {/* Keyed by currency: a currency change re-expresses the price, and the field shows it afresh. */}
              <AmountField key={currency} label={`Price (${currency})`} amount={fromSmallestUnit(combination.price, currency)} onAmount={(amount) => { if (amount !== undefined) setCombination(combination.id, { price: toSmallestUnit(amount, currency) }); }} />
            </View>
            <View className="flex-1">
              <AmountField label="Stock (blank: untracked)" whole amount={combination.stock} onAmount={(stock) => setCombination(combination.id, { stock })} />
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * A number typed in a field: the text is the user's own while they type
 * ("12." stays), and `onAmount` hears each value that parses. Blank is
 * `undefined` (untracked stock, no price yet).
 */
export function AmountField({ label, amount, onAmount, whole = false, testID }: { label: string; amount: number | undefined; onAmount: (value: number | undefined) => void; whole?: boolean; testID?: string }) {
  const [text, setText] = useState(amount === undefined ? '' : String(amount));
  return (
    <TextField
      label={label}
      keyboardType={whole ? 'number-pad' : 'decimal-pad'}
      value={text}
      testID={testID}
      onChangeText={(next) => {
        setText(next);
        if (next.trim() === '') {
          onAmount(undefined);
          return;
        }
        const value = Number(next.replace(',', '.'));
        if (Number.isFinite(value) && value >= 0) onAmount(whole ? Math.trunc(value) : value);
      }}
    />
  );
}
