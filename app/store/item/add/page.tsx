'use client'

import { useState, useMemo, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  ArrowLeftIcon,
  PhotoIcon,
  XMarkIcon,
  PlusIcon,
  TrashIcon
} from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { useSettingsStore } from '@/lib/store'
import { storeItemService } from '@/lib/services/store-item-service'
import { getCurrencyStep, toSmallestUnit, fromSmallestUnit, getCurrencyDecimals } from '@/lib/utils/format'
import type { VariantAxis, VariantCombination, ItemVariants } from '@/lib/types'

function AddItemPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const storeId = searchParams.get('storeId')
  const itemId = searchParams.get('itemId')
  const isEditMode = !!itemId
  const { user } = useAuth()
  const { isReady: sdkReady } = useSdk()
  const potatoMode = useSettingsStore((s) => s.potatoMode)

  const [isLoading, setIsLoading] = useState(isEditMode)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [basePrice, setBasePrice] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [imageUrls, setImageUrls] = useState<string[]>([])
  const [newImageUrl, setNewImageUrl] = useState('')
  const [category, setCategory] = useState('')
  const [stockQuantity, setStockQuantity] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadedStoreId, setLoadedStoreId] = useState<string | null>(null)

  // Variant state
  const [hasVariants, setHasVariants] = useState(false)
  const [variantAxes, setVariantAxes] = useState<VariantAxis[]>([])
  const [newAxisName, setNewAxisName] = useState('')
  const [newAxisOptions, setNewAxisOptions] = useState('')
  const [combinationPrices, setCombinationPrices] = useState<Record<string, string>>({})
  const [combinationStocks, setCombinationStocks] = useState<Record<string, string>>({})

  // Load existing item data in edit mode
  useEffect(() => {
    if (!sdkReady || !isEditMode || !itemId) return

    const loadItem = async () => {
      try {
        setIsLoading(true)
        const item = await storeItemService.getById(itemId)
        if (!item) {
          setError('Item not found')
          return
        }

        // Populate form fields
        const itemCurrency = item.currency || 'USD'
        const decimals = getCurrencyDecimals(itemCurrency)

        setTitle(item.title || '')
        setDescription(item.description || '')
        setCurrency(itemCurrency)
        setCategory(item.category || '')
        setImageUrls(item.imageUrls || [])
        setLoadedStoreId(item.storeId)

        // Convert price from smallest unit to display value
        if (item.basePrice !== undefined) {
          setBasePrice(fromSmallestUnit(item.basePrice, itemCurrency).toFixed(decimals))
        }
        if (item.stockQuantity !== undefined) {
          setStockQuantity(item.stockQuantity.toString())
        }

        // Load variants
        if (item.variants && item.variants.axes.length > 0) {
          setHasVariants(true)
          setVariantAxes(item.variants.axes)

          // Populate combination prices and stocks
          const prices: Record<string, string> = {}
          const stocks: Record<string, string> = {}
          for (const combo of item.variants.combinations) {
            prices[combo.key] = fromSmallestUnit(combo.price, itemCurrency).toFixed(decimals)
            // Only set stock if defined (undefined means unlimited/not tracked)
            if (combo.stock !== undefined && combo.stock !== null) {
              stocks[combo.key] = combo.stock.toString()
            }
          }
          setCombinationPrices(prices)
          setCombinationStocks(stocks)
        }
      } catch (err) {
        console.error('Failed to load item:', err)
        setError('Failed to load item data')
      } finally {
        setIsLoading(false)
      }
    }

    loadItem()
  }, [sdkReady, isEditMode, itemId])

  // Generate all combinations from axes
  const combinations = useMemo(() => {
    if (variantAxes.length === 0) return []

    const generateCombinations = (axes: VariantAxis[], index: number, current: string[]): string[][] => {
      if (index === axes.length) {
        return [current]
      }
      const results: string[][] = []
      for (const option of axes[index].options) {
        results.push(...generateCombinations(axes, index + 1, [...current, option]))
      }
      return results
    }

    return generateCombinations(variantAxes, 0, []).map(combo => combo.join('|'))
  }, [variantAxes])

  const handleAddImage = () => {
    if (newImageUrl && imageUrls.length < 4) {
      setImageUrls([...imageUrls, newImageUrl])
      setNewImageUrl('')
    }
  }

  const handleRemoveImage = (index: number) => {
    setImageUrls(imageUrls.filter((_, i) => i !== index))
  }

  const handleAddAxis = () => {
    if (!newAxisName.trim() || !newAxisOptions.trim()) return
    if (variantAxes.length >= 2) return // Max 2 axes

    const options = newAxisOptions.split(',').map(o => o.trim()).filter(Boolean)
    if (options.length === 0) return

    setVariantAxes([...variantAxes, { name: newAxisName.trim(), options }])
    setNewAxisName('')
    setNewAxisOptions('')
  }

  const handleRemoveAxis = (index: number) => {
    setVariantAxes(variantAxes.filter((_, i) => i !== index))
    // Clear combination prices/stocks when axes change
    setCombinationPrices({})
    setCombinationStocks({})
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user?.identityId || !title.trim()) return
    if (!isEditMode && !storeId) return

    setIsSubmitting(true)
    setError(null)

    try {
      const priceInSmallestUnit = basePrice ? toSmallestUnit(parseFloat(basePrice), currency) : undefined

      // Build variants if enabled
      let variants: ItemVariants | undefined
      if (hasVariants && variantAxes.length > 0 && combinations.length > 0) {
        const variantCombinations: VariantCombination[] = combinations.map(key => ({
          key,
          price: combinationPrices[key] ? toSmallestUnit(parseFloat(combinationPrices[key]), currency) : (priceInSmallestUnit || 0),
          stock: combinationStocks[key] ? parseInt(combinationStocks[key], 10) : undefined
        }))
        variants = { axes: variantAxes, combinations: variantCombinations }
      }

      // Include any pending image URL that wasn't explicitly added
      const allImageUrls = newImageUrl.trim()
        ? [...imageUrls, newImageUrl.trim()].slice(0, 4)
        : imageUrls

      const itemData = {
        title: title.trim(),
        description: description.trim() || undefined,
        basePrice: hasVariants ? undefined : priceInSmallestUnit,
        currency: currency || undefined,
        imageUrls: allImageUrls.length > 0 ? allImageUrls : undefined,
        category: category.trim() || undefined,
        stockQuantity: hasVariants ? undefined : (stockQuantity ? parseInt(stockQuantity, 10) : undefined),
        status: 'active' as const,
        variants
      }

      // Use URL storeId or fall back to loaded item's storeId for edit mode
      const effectiveStoreId = storeId || loadedStoreId

      if (isEditMode && itemId && effectiveStoreId) {
        await storeItemService.updateItem(itemId, user.identityId, effectiveStoreId, itemData)
      } else if (effectiveStoreId) {
        await storeItemService.createItem(user.identityId, effectiveStoreId, itemData)
      } else {
        setError('Store ID is required')
        return
      }

      router.push('/store/manage')
    } catch (err) {
      console.error(`Failed to ${isEditMode ? 'update' : 'create'} item:`, err)
      setError(`Failed to ${isEditMode ? 'update' : 'create'} product. Please try again.`)
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!storeId && !isEditMode) {
    return (
      <div className="min-h-[calc(100vh-40px)] flex">
        <Sidebar />
        <div className="flex-1 flex justify-center items-center">
          <p className="text-gray-500">No store ID provided</p>
        </div>
        <RightSidebar />
      </div>
    )
  }

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          <header className={`sticky top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 border-b border-gray-200 dark:border-gray-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
            <div className="flex items-center gap-4 p-4">
              <button
                onClick={() => router.back()}
                className="p-2 -ml-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
              >
                <ArrowLeftIcon className="h-5 w-5" />
              </button>
              <h1 className="text-xl font-bold">{isEditMode ? 'Edit Product' : 'Add Product'}</h1>
            </div>
          </header>

          {isLoading ? (
            <div className="flex items-center justify-center py-20">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-yappr-500" />
            </div>
          ) : (
          <form onSubmit={handleSubmit} className="p-4 space-y-6">
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-3 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-lg text-sm"
              >
                {error}
              </motion.div>
            )}

            {/* Title */}
            <div>
              <label className="block text-sm font-medium mb-2">
                Product Title <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Enter product title"
                className="w-full px-4 py-3 bg-gray-100 dark:bg-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
                required
                maxLength={200}
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm font-medium mb-2">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe your product"
                rows={4}
                className="w-full px-4 py-3 bg-gray-100 dark:bg-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500 resize-none"
                maxLength={2000}
              />
            </div>

            {/* Images */}
            <div>
              <label className="block text-sm font-medium mb-2">Product Images (max 4)</label>

              {imageUrls.length > 0 && (
                <div className="grid grid-cols-4 gap-2 mb-3">
                  {imageUrls.map((url, index) => (
                    <div key={index} className="relative aspect-square bg-gray-100 dark:bg-gray-900 rounded-lg overflow-hidden">
                      <img src={url} alt={`Product ${index + 1}`} className="w-full h-full object-cover" />
                      <button
                        type="button"
                        onClick={() => handleRemoveImage(index)}
                        className="absolute top-1 right-1 p-1 bg-black/50 rounded-full hover:bg-black/70 transition-colors"
                      >
                        <XMarkIcon className="h-4 w-4 text-white" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {imageUrls.length < 4 && (
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={newImageUrl}
                    onChange={(e) => setNewImageUrl(e.target.value)}
                    placeholder="Enter image URL"
                    className="flex-1 px-4 py-3 bg-gray-100 dark:bg-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleAddImage}
                    disabled={!newImageUrl}
                  >
                    <PlusIcon className="h-5 w-5" />
                  </Button>
                </div>
              )}
            </div>

            {/* Category */}
            <div>
              <label className="block text-sm font-medium mb-2">Category</label>
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g., Electronics, Clothing"
                className="w-full px-4 py-3 bg-gray-100 dark:bg-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
                maxLength={50}
              />
            </div>

            {/* Variants Toggle */}
            <div className="border-t border-gray-200 dark:border-gray-800 pt-6">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={hasVariants}
                  onChange={(e) => setHasVariants(e.target.checked)}
                  className="w-5 h-5 rounded border-gray-300 text-yappr-500 focus:ring-yappr-500"
                />
                <span className="font-medium">This product has variants (e.g., size, color)</span>
              </label>
            </div>

            {hasVariants ? (
              /* Variants Section */
              <div className="space-y-4">
                {/* Existing Axes */}
                {variantAxes.map((axis, index) => (
                  <div key={index} className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-medium">{axis.name}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveAxis(index)}
                        className="p-1 text-red-500 hover:bg-red-100 dark:hover:bg-red-900/30 rounded"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {axis.options.map((option, optIndex) => (
                        <span key={optIndex} className="px-2 py-1 bg-white dark:bg-gray-800 rounded text-sm">
                          {option}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}

                {/* Add New Axis */}
                {variantAxes.length < 2 && (
                  <div className="p-3 border border-dashed border-gray-300 dark:border-gray-700 rounded-lg">
                    <p className="text-sm text-gray-500 mb-3">
                      Add variant option (max 2, e.g., Size, Color)
                    </p>
                    <div className="grid grid-cols-2 gap-2 mb-2">
                      <input
                        type="text"
                        value={newAxisName}
                        onChange={(e) => setNewAxisName(e.target.value)}
                        placeholder="Option name (e.g., Size)"
                        className="px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500 text-sm"
                      />
                      <input
                        type="text"
                        value={newAxisOptions}
                        onChange={(e) => setNewAxisOptions(e.target.value)}
                        placeholder="Values (e.g., S, M, L)"
                        className="px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500 text-sm"
                      />
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={handleAddAxis}
                      disabled={!newAxisName.trim() || !newAxisOptions.trim()}
                    >
                      <PlusIcon className="h-4 w-4 mr-1" />
                      Add Option
                    </Button>
                  </div>
                )}

                {/* Combinations Table */}
                {combinations.length > 0 && (
                  <div>
                    <label className="block text-sm font-medium mb-2">
                      Variant Pricing & Stock
                    </label>
                    <div className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 dark:bg-gray-900">
                          <tr>
                            <th className="px-3 py-2 text-left font-medium">Variant</th>
                            <th className="px-3 py-2 text-left font-medium">Price ({currency})</th>
                            <th className="px-3 py-2 text-left font-medium">Stock</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                          {combinations.map((key) => (
                            <tr key={key}>
                              <td className="px-3 py-2 font-medium">{key.replace(/\|/g, ' / ')}</td>
                              <td className="px-3 py-2">
                                <input
                                  type="number"
                                  value={combinationPrices[key] || ''}
                                  onChange={(e) => setCombinationPrices({ ...combinationPrices, [key]: e.target.value })}
                                  placeholder="0.00"
                                  step={getCurrencyStep(currency)}
                                  min="0"
                                  className="w-24 px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded focus:outline-none focus:ring-2 focus:ring-yappr-500"
                                />
                              </td>
                              <td className="px-3 py-2">
                                <input
                                  type="number"
                                  value={combinationStocks[key] || ''}
                                  onChange={(e) => setCombinationStocks({ ...combinationStocks, [key]: e.target.value })}
                                  placeholder="Unlimited"
                                  min="0"
                                  className="w-20 px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded focus:outline-none focus:ring-2 focus:ring-yappr-500"
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Simple Price & Stock */
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">Price</label>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                      <input
                        type="number"
                        value={basePrice}
                        onChange={(e) => setBasePrice(e.target.value)}
                        placeholder="0.00"
                        step={getCurrencyStep(currency)}
                        min="0"
                        className="w-full pl-8 pr-4 py-3 bg-gray-100 dark:bg-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">Currency</label>
                    <select
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value)}
                      className="w-full px-4 py-3 bg-gray-100 dark:bg-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
                    >
                      <option value="USD">USD</option>
                      <option value="EUR">EUR</option>
                      <option value="GBP">GBP</option>
                      <option value="DASH">DASH</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">Stock Quantity</label>
                  <input
                    type="number"
                    value={stockQuantity}
                    onChange={(e) => setStockQuantity(e.target.value)}
                    placeholder="Unlimited"
                    min="0"
                    className="w-full px-4 py-3 bg-gray-100 dark:bg-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
                  />
                </div>
              </>
            )}

            {/* Currency selector when variants enabled */}
            {hasVariants && (
              <div>
                <label className="block text-sm font-medium mb-2">Currency</label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="w-full px-4 py-3 bg-gray-100 dark:bg-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
                >
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                  <option value="GBP">GBP</option>
                  <option value="DASH">DASH</option>
                </select>
              </div>
            )}

            {/* Submit */}
            <div className="pt-4">
              <Button
                type="submit"
                disabled={isSubmitting || !title.trim()}
                className="w-full"
              >
                {isSubmitting
                  ? (isEditMode ? 'Saving...' : 'Creating...')
                  : (isEditMode ? 'Save Changes' : 'Create Product')}
              </Button>
            </div>
          </form>
          )}
        </main>
      </div>

      <RightSidebar />
    </div>
  )
}

export default withAuth(AddItemPage)
