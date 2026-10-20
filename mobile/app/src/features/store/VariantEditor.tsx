import type { ItemVariants, VariantCombination } from '@engine/api';
import { useState } from 'react';
import { View } from 'react-native';

import { fromSmallestUnit, toSmallestUnit } from '~/lib-allowlist';
import { Button } from '~/ui/Button';
import { Card } from '~/ui/Card';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';

/** The contract's option ids run 1–254 and are never reused (`ItemVariants.nextOptionId`). */
const MAX_OPTION_ID = 254;

const combinationId = (optionIds: readonly number[]) => [...optionIds].sort((a, b) => a - b).join('.');

/**
 * `variants` with an axis's options set from `names`: options keep their ids
 * by name, new ones take fresh ids, and the combinations are the full grid,
 * each keeping its price, stock and SKU when it existed before.
 */
export function withAxes(variants: ItemVariants, axes: { name: string; options: string[] }[], defaultPrice: number): ItemVariants {
  let next = variants.nextOptionId;
  const known = new Map(variants.axes.flatMap((axis) => axis.options.map((option) => [`${axis.name.trim().toLowerCase()}|${option.name.trim().toLowerCase()}`, option.id] as const)));
  const built = axes
    .filter((axis) => axis.name.trim() && axis.options.some((name) => name.trim()))
    .map((axis) => ({
      name: axis.name.trim(),
      options: [...new Set(axis.options.map((name) => name.trim()).filter(Boolean))].map((name) => {
        const id = known.get(`${axis.name.trim().toLowerCase()}|${name.toLowerCase()}`);
        if (id !== undefined) return { id, name };
        if (next > MAX_OPTION_ID) throw new Error('This product has used up its option ids. Create a new product for more options.');
        return { id: next++, name };
      }),
    }));
  const grid = built.reduce<number[][]>((rows, axis) => rows.flatMap((row) => axis.options.map((option) => [...row, option.id])), [[]]);
  const previous = new Map(variants.combinations.map((combination) => [combination.id, combination]));
  const combinations: VariantCombination[] = built.length === 0 ? [] : grid.map((optionIds) => {
    const id = combinationId(optionIds);
    const before = previous.get(id);
    return { ...(before ?? { price: defaultPrice }), id, optionIds };
  });
  return { axes: built, combinations, nextOptionId: next };
}

export const emptyVariants = (): ItemVariants => ({ axes: [], combinations: [], nextOptionId: 1 });

/**
 * Options (web `VariantEditor`): axes like Size or Color, each with its
 * options, and a price and stock for every combination.
 */
export function VariantEditor({ variants, currency, defaultPrice, onChange }: { variants: ItemVariants; currency: string; defaultPrice: number; onChange: (next: ItemVariants) => void }) {
  const [draft, setDraft] = useState(() => variants.axes.map((axis) => ({ name: axis.name, options: axis.options.map((option) => option.name).join(', ') })));
  const [error, setError] = useState<string | null>(null);
  const apply = (rows: typeof draft) => {
    setDraft(rows);
    try {
      onChange(withAxes(variants, rows.map((row) => ({ name: row.name, options: row.options.split(',') })), defaultPrice));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'These options could not be used.');
    }
  };
  const labelOf = (combination: VariantCombination) =>
    combination.optionIds.map((id) => variants.axes.flatMap((axis) => axis.options).find((option) => option.id === id)?.name ?? '?').join(' / ');
  const setCombination = (id: string, patch: Partial<VariantCombination>) =>
    onChange({ ...variants, combinations: variants.combinations.map((combination) => (combination.id === id ? { ...combination, ...patch } : combination)) });

  return (
    <View className="gap-3" testID="variant-editor">
      {draft.map((row, index) => (
        <Card key={index} className="gap-2 p-3">
          <TextField label="Option name" value={row.name} placeholder="Size" onChangeText={(name) => apply(draft.map((r, i) => (i === index ? { ...r, name } : r)))} testID={`variant-axis-${index}`} />
          <TextField label="Choices, separated by commas" value={row.options} placeholder="S, M, L" onChangeText={(options) => apply(draft.map((r, i) => (i === index ? { ...r, options } : r)))} testID={`variant-options-${index}`} />
          <Button size="sm" variant="ghost" label="Remove option" onPress={() => apply(draft.filter((_, i) => i !== index))} />
        </Card>
      ))}
      {draft.length < 3 ? <Button size="sm" variant="outline" label="Add an option (size, color…)" onPress={() => setDraft([...draft, { name: '', options: '' }])} testID="variant-add-axis" /> : null}
      {error ? <Text tone="error">{error}</Text> : null}
      {variants.combinations.map((combination) => (
        <View key={combination.id} className="gap-1">
          <Text variant="bodyStrong">{labelOf(combination)}</Text>
          <View className="flex-row gap-2">
            <View className="flex-1">
              <AmountField label={`Price (${currency})`} amount={fromSmallestUnit(combination.price, currency)} onAmount={(amount) => { if (amount !== undefined) setCombination(combination.id, { price: toSmallestUnit(amount, currency) }); }} />
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
