import type { ItemVariants } from '@engine/api';

import { addAxis, addOption, convertVariantPrices, emptyVariants, remapVariantImages, removeOption, renameOption } from './VariantEditor';

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
    // Blue comes only with the sizes still offered: S and L, not the removed M.
    expect(next.combinations.filter((c) => c.optionIds.includes(5)).map((c) => c.id)).toEqual(['1.5', '3.5']);
  });

  it('projects a new choice onto the patterns offered, not the whole grid', () => {
    // Two axes of three choices, offered only on the diagonal (web can remove combinations).
    const full = addOption(addOption(addAxis(addOption(addOption(addAxis(emptyVariants(), 'A', 'a1', 1), 0, 'a2', 1), 0, 'a3', 1), 'B', 'b1', 1), 1, 'b2', 1), 1, 'b3', 1);
    const diagonal = { ...full, combinations: full.combinations.filter((c) => ['1.4', '2.5', '3.6'].includes(c.id)) };
    const next = addOption(diagonal, 1, 'b4', 1);
    expect(next.combinations.filter((c) => c.optionIds.includes(7)).map((c) => c.id)).toEqual(['1.7', '2.7', '3.7']);
  });

  it("removing an axis's last unsaved choice removes the axis and keeps the other choices offered", () => {
    const sized = addOption(addAxis(emptyVariants(), 'Size', 'S', 100), 0, 'M', 100);
    const withColor = addAxis(sized, 'Color', 'Red', 100);
    const next = removeOption(withColor, 3);
    expect(next.axes.map((axis) => axis.name)).toEqual(['Size']);
    expect(next.combinations.map((c) => c.id)).toEqual(['1', '2']);
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

  it('keeps each combination on its photo when the gallery changes', () => {
    const withPhotos = { ...colors, combinations: [{ ...colors.combinations[0], image: 2 }, { ...colors.combinations[1], image: 1 }] };
    const next = remapVariantImages(withPhotos, ['A', 'B', 'C'], ['B', 'C']);
    expect(next.combinations[0].image).toBe(1);
    expect('image' in next.combinations[1]).toBe(false);
  });
});
