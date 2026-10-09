/**
 * The variants JSON string storefront v1–v6 store (testnet production and the
 * /testing build run v1), translated to and from the v7 table the app works
 * with. Only `store-item-service` calls this; everything else sees the v7
 * model. Pure.
 *
 * The JSON has no option ids, so they are numbered 1, 2, 3… in axis and
 * option order on every read. They are stable while the listing's options
 * keep their order; a cart line named by them is re-checked against the
 * listing at checkout like any other.
 */
import type { ItemVariants, VariantAxis, VariantCombination } from '@/lib/types'
import { variantIdOf } from './variant-codec'

interface LegacyCombination {
  key: string
  price: number
  stock?: number
  sku?: string
  imageUrl?: string
}

/** The v1–v6 shape: option names per axis, combinations keyed by their names joined with "|". */
interface LegacyVariants {
  axes: { name: string; options: string[] }[]
  combinations: LegacyCombination[]
}

const KEY_SEPARATOR = '|'

/**
 * The table a v1–v6 item stores as JSON, or undefined when there is none
 * usable. A combination whose key names an unknown option, or repeats
 * another, is dropped. A combination image that is one of `imageUrls`
 * becomes its index; any other is kept as its own URL.
 */
export function decodeLegacyVariants(json: unknown, imageUrls: readonly string[] = []): ItemVariants | undefined {
  if (typeof json !== 'string' || !json) return undefined
  let parsed: Partial<LegacyVariants>
  try {
    parsed = JSON.parse(json) as Partial<LegacyVariants>
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.axes) || parsed.axes.length === 0 || !Array.isArray(parsed.combinations)) return undefined

  let nextOptionId = 1
  const axes: VariantAxis[] = []
  for (const axis of parsed.axes) {
    if (!axis || typeof axis.name !== 'string' || !Array.isArray(axis.options)) return undefined
    const names = [...new Set(axis.options.filter((name): name is string => typeof name === 'string'))]
    if (names.length === 0) return undefined
    axes.push({ name: axis.name, options: names.map((name) => ({ id: nextOptionId++, name })) })
  }

  const combinations: VariantCombination[] = []
  const seen = new Set<string>()
  for (const legacy of parsed.combinations) {
    if (!legacy || typeof legacy.key !== 'string' || typeof legacy.price !== 'number' || !Number.isSafeInteger(legacy.price) || legacy.price < 0) continue
    const names = legacy.key.split(KEY_SEPARATOR)
    if (names.length !== axes.length) continue
    const optionIds = names.map((name, axisIndex) => axes[axisIndex].options.find((option) => option.name === name)?.id)
    if (optionIds.some((optionId) => optionId === undefined)) continue
    const ids = optionIds as number[]
    const id = variantIdOf(ids)
    if (seen.has(id)) continue
    seen.add(id)
    const combination: VariantCombination = { id, optionIds: ids, price: legacy.price }
    if (typeof legacy.stock === 'number' && Number.isSafeInteger(legacy.stock) && legacy.stock >= 0) combination.stock = legacy.stock
    if (typeof legacy.sku === 'string' && legacy.sku) combination.sku = legacy.sku
    const image = typeof legacy.imageUrl === 'string' ? imageUrls.indexOf(legacy.imageUrl) + 1 : 0
    if (image > 0) combination.image = image
    else if (typeof legacy.imageUrl === 'string' && legacy.imageUrl) combination.imageUrl = legacy.imageUrl
    combinations.push(combination)
  }
  return combinations.length > 0 ? { axes, combinations, nextOptionId } : undefined
}

/** `variants` as the v1–v6 JSON string (no weights: those cuts have none). */
export function encodeLegacyVariants(variants: ItemVariants, imageUrls: readonly string[] = []): string {
  const nameOf = new Map(variants.axes.flatMap((axis) => axis.options.map((option) => [option.id, option.name] as const)))
  const legacy: LegacyVariants = {
    axes: variants.axes.map((axis) => ({ name: axis.name, options: axis.options.map((option) => option.name) })),
    combinations: variants.combinations.map((combination) => {
      const entry: LegacyCombination = {
        key: combination.optionIds.map((optionId) => nameOf.get(optionId) ?? '').join(KEY_SEPARATOR),
        price: combination.price,
      }
      if (combination.stock !== undefined) entry.stock = combination.stock
      if (combination.sku) entry.sku = combination.sku
      const imageUrl = combination.image ? imageUrls[combination.image - 1] : combination.imageUrl
      if (imageUrl) entry.imageUrl = imageUrl
      return entry
    }),
  }
  return JSON.stringify(legacy)
}
