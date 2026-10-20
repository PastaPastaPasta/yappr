import type { ItemVariants } from '@engine/api';

import { addAxis, addOption, convertVariantPrices, emptyVariants, removeOption, renameOption } from './VariantEditor';

const colors: ItemVariants = {
  axes: [{ name: 'Color', options: [{ id: 1, name: 'Red' }, { id: 2, name: 'Blue' }] }],
  combinations: [
    { id: '1', optionIds: [1], price: 500, stock: 3, sku: 'R' },
    { id: '2', optionIds: [2], price: 2000 },
  ],
  nextOptionId: 3,
};

describe('id-stable variant edits', () => {
  it('renames an option in place, keeping its id and every combination', () => {
    const next = renameOption(colors, 1, 'Crimson');
    expect(next.axes[0].options).toEqual([{ id: 1, name: 'Crimson' }, { id: 2, name: 'Blue' }]);
    expect(next.combinations).toEqual(colors.combinations);
  });

  it('adds a choice with a fresh id and only its own combinations', () => {
    const next = addOption(colors, 0, 'Green', 700);
    expect(next.nextOptionId).toBe(4);
    expect(next.axes[0].options.at(-1)).toEqual({ id: 3, name: 'Green' });
    expect(next.combinations).toEqual([...colors.combinations, { id: '3', optionIds: [3], price: 700 }]);
  });

  it('never restores a combination removed elsewhere when a choice is added', () => {
    const sized = { ...addAxis(emptyVariants(), 'Size', 'S', 100) };
    const grid = addOption(addOption(sized, 0, 'M', 100), 0, 'L', 100);
    const two = addAxis({ ...grid }, 'Color', 'Red', 100);
    // The seller removed "M / Red" on web.
    const trimmed = { ...two, combinations: two.combinations.filter((c) => c.id !== [2, 4].sort().join('.')) };
    const next = addOption(trimmed, 1, 'Blue', 100);
    expect(next.combinations.some((c) => c.id === '2.4')).toBe(false);
    expect(next.combinations.filter((c) => c.optionIds.includes(5))).toHaveLength(3);
  });

  it('removing an unsaved choice never moves another choice onto its id', () => {
    const added = addOption(colors, 0, 'Green', 700);
    const next = removeOption(added, 3);
    expect(next.axes[0].options).toEqual(colors.axes[0].options);
    expect(next.nextOptionId).toBe(4);
  });

  it('re-expresses prices in the new currency', () => {
    expect(convertVariantPrices(colors, 'USD', 'EUR').combinations.map((c) => c.price)).toEqual([500, 2000]);
    expect(convertVariantPrices(colors, 'USD', 'DASH').combinations.map((c) => c.price)).toEqual([500_000_000, 2_000_000_000]);
  });
});
