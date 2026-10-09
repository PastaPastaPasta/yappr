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

/** The real VariantEditor over a two-combination table; `legacy` as the v1–v6 editor runs it. */
export function VariantEditorFixture({ legacy }: { legacy: boolean }) {
  const [variants, setVariants] = useState<ItemVariants>(start)
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
