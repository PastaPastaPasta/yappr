import { useState } from 'react'
import { VariantEditor } from '@/components/store/variant-editor'
import { variantsFromRows } from '@/lib/storefront/variant-codec'
import type { ItemVariants } from '@/lib/types'

declare global {
  interface Window {
    variantEditorValue: () => ItemVariants
  }
}

const start = variantsFromRows(['Size'], [{ optionNames: ['S'], price: 100, sku: 'SHORT' }, { optionNames: ['M'], price: 100 }]).variants as ItemVariants
/** As a v1–v6 listing can be read: M keeps its own photo, which is not among the listing's (no) images. */
const legacyStart: ItemVariants = {
  ...start,
  combinations: start.combinations.map((combination) => (combination.id === '2' ? { ...combination, imageUrl: 'https://x.test/m.jpg' } : combination)),
}

/** The real VariantEditor over a two-combination table; `legacy` as the v1–v6 editor runs it. */
export function VariantEditorFixture({ legacy }: { legacy: boolean }) {
  const [variants, setVariants] = useState<ItemVariants>(legacy ? legacyStart : start)
  window.variantEditorValue = () => variants
  return (
    <VariantEditor
      variants={variants}
      onChange={setVariants}
      currency="USD"
      defaultPrice={100}
      imageUrls={[]}
      showWeight={!legacy}
      legacy={legacy}
    />
  )
}
