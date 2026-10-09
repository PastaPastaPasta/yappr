'use client'

import { useState, type InputHTMLAttributes, type KeyboardEvent } from 'react'
import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, PlusIcon, TrashIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { IpfsImage } from '@/components/ui/ipfs-image'
import type { ItemVariants, VariantAxis, VariantCombination } from '@/lib/types'
import { VARIANT_LIMITS } from '@/lib/storefront/storefront-contract'
import {
  addAxis, addOption, findOption, moveAxis, moveOption, optionIdsLeft, removeAxis, removeCombination, removeOption, renameAxis, renameOption,
  restoreCombinations, sameName, setStockTracking, tracksStock, updateCombination, updateCombinations, variantLabel,
  type CombinationData, type CombinationDefaults,
} from '@/lib/storefront/variant-codec'
import {
  formatPriceInput, fullGridSize, missingCombinationCount, parseCountInput, parsePriceInput, splitOptionNames, variantGrowthProblem,
} from '@/lib/storefront/variant-editor-model'

interface VariantEditorProps {
  variants: ItemVariants
  onChange: (variants: ItemVariants) => void
  currency: string
  /** What a newly added combination costs (smallest unit). */
  defaultPrice: number
  /** The listing's images; a combination may show one of them. */
  imageUrls: string[]
  /** Per-combination weights (storefront v7 only). */
  showWeight: boolean
  /** v1–v6: each combination's stock is tracked on its own (an empty entry stops tracking it). */
  perCombinationStock?: boolean
  /**
   * The listing is saved with this table (v7): it may shrink but never empty,
   * since its option-id counter lives in it and a new table would hand old ids
   * (named by carts and kits) to other options.
   */
  keepTable?: boolean
  disabled?: boolean
}

const fieldClass = 'px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500 text-sm'
const cellClass = 'px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded focus:outline-none focus:ring-2 focus:ring-yappr-500 aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-red-500'
const iconButtonClass = 'p-1 rounded text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-transparent'

/** Enter in a field of the editor must not submit the product form. */
function keepEnter(event: KeyboardEvent<HTMLInputElement>): boolean {
  if (event.key !== 'Enter') return false
  event.preventDefault()
  return true
}
/** Enter runs `action` instead of submitting the product form. */
const onEnter = (action: () => void) => (event: KeyboardEvent<HTMLInputElement>) => {
  if (keepEnter(event)) action()
}

/**
 * A number field that keeps what the seller is typing and hands each valid
 * value up as it is typed (`onDraft` returns false for one that is not).
 * Leaving the field shows the saved value again.
 */
function DraftInput({ value, onDraft, ...props }: { value: string; onDraft: (text: string) => boolean } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  return (
    <input
      inputMode="decimal"
      {...props}
      value={draft ?? value}
      aria-invalid={invalid}
      onKeyDown={keepEnter}
      onChange={(event) => {
        setDraft(event.target.value)
        setInvalid(!onDraft(event.target.value))
      }}
      onBlur={() => {
        setDraft(null)
        setInvalid(false)
      }}
    />
  )
}

export function VariantEditor({ variants, onChange, currency, defaultPrice, imageUrls, showWeight, perCombinationStock = false, keepTable = false, disabled = false }: VariantEditorProps) {
  // With no combinations there is nothing to read tracking from, so remember the seller's choice.
  const [trackWhenEmpty, setTrackWhenEmpty] = useState(() => tracksStock(variants))
  const trackStock = variants.combinations.length > 0 ? tracksStock(variants) : trackWhenEmpty
  const defaults: CombinationDefaults = trackStock ? { price: defaultPrice, stock: 0 } : { price: defaultPrice }
  const [notice, setNotice] = useState<string | null>(null)
  /** What an edit changed beyond what the seller typed (shown, not an error). */
  const [info, setInfo] = useState<string | null>(null)

  const [newAxisName, setNewAxisName] = useState('')
  const [newAxisOptions, setNewAxisOptions] = useState('')
  const [bulkTarget, setBulkTarget] = useState('all')
  const [bulkPrice, setBulkPrice] = useState('')
  const [bulkStock, setBulkStock] = useState('')

  /** Apply an edit unless it makes the table larger than a product may be; whether it was applied. */
  const apply = (next: ItemVariants): boolean => {
    const problem = variantGrowthProblem(next)
    if (problem) {
      setNotice(problem)
      return false
    }
    setNotice(null)
    setInfo(null)
    onChange(next)
    return true
  }

  /** Add `count` options through `add`, unless the product has no option numbers left for them. */
  const addOptions = (count: number, add: () => ItemVariants): boolean => {
    if (count > optionIdsLeft(variants)) {
      setNotice('This product has used all its option numbers. To offer more options, list it again as a new product.')
      return false
    }
    return apply(add())
  }

  const handleRemoveAxis = (axisIndex: number) => {
    const next = removeAxis(variants, axisIndex)
    setNotice(null)
    setInfo(next.axes.length > 0 && next.combinations.length < variants.combinations.length
      ? `Combinations that differed only by ${variants.axes[axisIndex].name} were merged, each keeping the first one's price, stock and SKU. Check them below.`
      : null)
    onChange(next)
  }

  const canAddAxis = variants.axes.length < VARIANT_LIMITS.axes
  const handleAddAxis = () => {
    const name = newAxisName.trim()
    const names = splitOptionNames(newAxisOptions)
    if (!name || names.length === 0 || !canAddAxis) return
    if (variants.axes.some((axis) => sameName(axis.name, name))) {
      setNotice(`There is already an option type called "${name}".`)
      return
    }
    if (!addOptions(names.length, () => addAxis(variants, name, names, defaults))) return
    if (names.length > 1 && variants.combinations.length > 0) {
      setInfo(`Each combination now comes in every ${name}. Their prices were kept; set their stock and SKUs below.`)
    }
    setNewAxisName('')
    setNewAxisOptions('')
  }

  const handleTrackStock = (tracked: boolean) => {
    setTrackWhenEmpty(tracked)
    onChange(setStockTracking(variants, tracked))
  }

  const bulkOptionId = bulkTarget === 'all' ? undefined : Number(bulkTarget)
  const bulkOptionName = bulkOptionId === undefined ? undefined : findOption(variants, bulkOptionId)?.option.name
  // A target removed since it was chosen falls back to every combination.
  const bulkScope = bulkOptionName === undefined ? undefined : bulkOptionId
  const bulkPriceValue = parsePriceInput(bulkPrice, currency)
  const bulkStockValue = parseCountInput(bulkStock, VARIANT_LIMITS.maxStock)
  const missing = missingCombinationCount(variants)
  const handleRestore = () => {
    // Refuse a grid too large to offer before building it, since it can be very large.
    const size = fullGridSize(variants)
    if (size > VARIANT_LIMITS.combinations) {
      setNotice(`Offering every combination would make ${size}, and a product can offer at most ${VARIANT_LIMITS.combinations}. Remove some options first.`)
      return
    }
    apply(restoreCombinations(variants, defaults))
  }
  const setBulkPrices = () => {
    if (bulkPriceValue === undefined) return
    onChange(updateCombinations(variants, { price: bulkPriceValue }, bulkScope))
    setBulkPrice('')
  }
  const setBulkStocks = () => {
    if (bulkStockValue === undefined) return
    onChange(updateCombinations(variants, { stock: bulkStockValue }, bulkScope))
    setBulkStock('')
  }

  return (
    <div className="space-y-4">
      {variants.axes.map((axis, axisIndex) => (
        <AxisCard
          key={Math.min(...axis.options.map((option) => option.id))}
          axis={axis}
          axisIndex={axisIndex}
          axisCount={variants.axes.length}
          disabled={disabled}
          onRename={(name) => onChange(renameAxis(variants, axisIndex, name))}
          onMove={(to) => onChange(moveAxis(variants, axisIndex, to))}
          canRemove={!keepTable || variants.axes.length > 1}
          canRemoveLastOption={!keepTable || variants.axes.length > 1}
          onRemove={() => handleRemoveAxis(axisIndex)}
          onAddOptions={(names) => addOptions(names.length, () => names.reduce((next, name) => addOption(next, axisIndex, name, defaults), variants))}
          onRenameOption={(optionId, name) => onChange(renameOption(variants, optionId, name))}
          onMoveOption={(optionId, offset) => onChange(moveOption(variants, optionId, offset))}
          onRemoveOption={(optionId) => onChange(removeOption(variants, optionId))}
        />
      ))}

      {canAddAxis ? (
        <div className="p-3 border border-dashed border-gray-300 dark:border-gray-700 rounded-lg">
          <p className="text-sm text-gray-500 mb-3">
            Add an option type, such as Size or Color (up to {VARIANT_LIMITS.axes})
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
            <input
              type="text"
              aria-label="New option type name"
              value={newAxisName}
              onChange={(event) => setNewAxisName(event.target.value)}
              onKeyDown={onEnter(handleAddAxis)}
              placeholder="Option type (e.g., Size)"
              maxLength={VARIANT_LIMITS.axisNameLength}
              disabled={disabled}
              className={fieldClass}
            />
            <input
              type="text"
              aria-label="Options for the new option type, separated by commas"
              value={newAxisOptions}
              onChange={(event) => setNewAxisOptions(event.target.value)}
              onKeyDown={onEnter(handleAddAxis)}
              placeholder="Options (e.g., S, M, L)"
              disabled={disabled}
              className={fieldClass}
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleAddAxis}
            disabled={disabled || !newAxisName.trim() || splitOptionNames(newAxisOptions).length === 0}
          >
            <PlusIcon className="h-4 w-4 mr-1" />
            Add option type
          </Button>
        </div>
      ) : (
        <p className="text-sm text-gray-500">A product can have up to {VARIANT_LIMITS.axes} option types.</p>
      )}

      {notice && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-red-600 dark:text-red-400">
          <p>{notice}</p>
        </div>
      )}
      {info && <p role="status" className="text-sm text-gray-600 dark:text-gray-400">{info}</p>}

      {variants.axes.length > 0 && (
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={trackStock}
            onChange={(event) => handleTrackStock(event.target.checked)}
            disabled={disabled}
            className="w-5 h-5 rounded border-gray-300 text-yappr-500 focus:ring-yappr-500"
          />
          <span className="text-sm">
            <span className="font-medium">Track inventory</span>
            <span className="block text-xs text-gray-500">Set how many of each combination you have. Off means unlimited.</span>
          </span>
        </label>
      )}

      {variants.combinations.length > 0 && (
        <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg space-y-2">
          <p className="text-sm font-medium">Quick edit</p>
          <select
            aria-label="Which combinations to change"
            value={bulkScope === undefined ? 'all' : String(bulkScope)}
            onChange={(event) => setBulkTarget(event.target.value)}
            disabled={disabled}
            className={`${fieldClass} w-full`}
          >
            <option value="all">All combinations</option>
            {variants.axes.map((axis, axisIndex) => (
              <optgroup key={axisIndex} label={axis.name || 'Option type'}>
                {axis.options.map((option) => (
                  <option key={option.id} value={option.id}>Every {option.name || 'unnamed option'}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <div className="flex flex-wrap gap-2">
            <div className="flex gap-2">
              <input
                type="text"
                inputMode="decimal"
                aria-label={`Price to set (${currency})`}
                value={bulkPrice}
                onChange={(event) => setBulkPrice(event.target.value)}
                onKeyDown={onEnter(setBulkPrices)}
                placeholder={`Price (${currency})`}
                disabled={disabled}
                className={`${fieldClass} w-32`}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || bulkPriceValue === undefined}
                onClick={setBulkPrices}
              >
                {bulkOptionName === undefined ? 'Set all prices' : `Set price for every ${bulkOptionName}`}
              </Button>
            </div>
            {trackStock && (
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label="Stock to set"
                  value={bulkStock}
                  onChange={(event) => setBulkStock(event.target.value)}
                  onKeyDown={onEnter(setBulkStocks)}
                  placeholder="Stock"
                  disabled={disabled}
                  className={`${fieldClass} w-24`}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || bulkStockValue === undefined}
                  onClick={setBulkStocks}
                >
                  {bulkOptionName === undefined ? 'Set all stock' : `Set stock for every ${bulkOptionName}`}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {variants.axes.length > 0 && (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <p className="text-sm font-medium">
              {variants.combinations.length === 1 ? '1 combination' : `${variants.combinations.length} combinations`}
            </p>
            {missing > 0 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={handleRestore}
              >
                <PlusIcon className="h-4 w-4 mr-1" />
                {missing === 1 ? 'Add the missing combination' : `Add the ${missing} missing combinations`}
              </Button>
            )}
          </div>
          {variants.combinations.length === 0 ? (
            <p className="text-sm text-gray-500">No combinations are offered. Add the missing ones to sell this product.</p>
          ) : (
            <div className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-auto max-h-[32rem]">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900 sticky top-0 z-10">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Combination</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Price ({currency})</th>
                    {trackStock && <th className="px-3 py-2 text-left font-medium">Stock</th>}
                    <th className="px-3 py-2 text-left font-medium">SKU</th>
                    {showWeight && <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Weight (g)</th>}
                    {imageUrls.length > 0 && <th className="px-3 py-2 text-left font-medium">Image</th>}
                    <th className="px-3 py-2"><span className="sr-only">Remove</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                  {variants.combinations.map((combination) => (
                    <CombinationRow
                      key={combination.id}
                      combination={combination}
                      label={variantLabel(variants, combination)}
                      currency={currency}
                      trackStock={trackStock}
                      showWeight={showWeight}
                      perCombinationStock={perCombinationStock}
                      imageUrls={imageUrls}
                      disabled={disabled}
                      onUpdate={(patch) => onChange(updateCombination(variants, combination.id, patch))}
                      onRemove={() => {
                        setTrackWhenEmpty(trackStock)
                        onChange(removeCombination(variants, combination.id))
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

interface AxisCardProps {
  axis: VariantAxis
  axisIndex: number
  axisCount: number
  disabled: boolean
  onRename: (name: string) => void
  onMove: (to: number) => void
  /** Whether the option type can go (a kept table keeps one). */
  canRemove: boolean
  /** Whether its only option can go (which removes the option type too). */
  canRemoveLastOption: boolean
  onRemove: () => void
  onAddOptions: (names: string[]) => void
  onRenameOption: (optionId: number, name: string) => void
  onMoveOption: (optionId: number, offset: -1 | 1) => void
  onRemoveOption: (optionId: number) => void
}

function AxisCard({ axis, axisIndex, axisCount, disabled, canRemove, canRemoveLastOption, onRename, onMove, onRemove, onAddOptions, onRenameOption, onMoveOption, onRemoveOption }: AxisCardProps) {
  const [newOptions, setNewOptions] = useState('')
  const axisName = axis.name.trim() || `option type ${axisIndex + 1}`
  const names = splitOptionNames(newOptions, axis.options.map((option) => option.name))
  const handleAdd = () => {
    if (names.length === 0) return
    onAddOptions(names)
    setNewOptions('')
  }

  return (
    <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg space-y-3">
      <div className="flex items-center gap-1">
        <input
          type="text"
          aria-label={`Name of ${axisName}`}
          value={axis.name}
          onChange={(event) => onRename(event.target.value)}
          onKeyDown={keepEnter}
          maxLength={VARIANT_LIMITS.axisNameLength}
          disabled={disabled}
          className={`${fieldClass} flex-1 min-w-0 font-medium bg-white dark:bg-gray-800`}
        />
        <button type="button" aria-label={`Move ${axisName} up`} onClick={() => onMove(axisIndex - 1)} disabled={disabled || axisIndex === 0} className={iconButtonClass}>
          <ArrowUpIcon className="h-4 w-4" />
        </button>
        <button type="button" aria-label={`Move ${axisName} down`} onClick={() => onMove(axisIndex + 1)} disabled={disabled || axisIndex === axisCount - 1} className={iconButtonClass}>
          <ArrowDownIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label={`Remove ${axisName}`}
          onClick={onRemove}
          disabled={disabled || !canRemove}
          className="p-1 text-red-500 hover:bg-red-100 dark:hover:bg-red-900/30 rounded disabled:opacity-30"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      </div>

      <ul className="flex flex-wrap gap-2" aria-label={`Options of ${axisName}`}>
        {axis.options.map((option, optionIndex) => {
          const optionName = option.name.trim() || `option ${optionIndex + 1}`
          return (
            <li key={option.id} className="flex items-center gap-0.5 pl-1 pr-0.5 py-0.5 bg-white dark:bg-gray-800 rounded-lg">
              <input
                type="text"
                aria-label={`Name of ${optionName} in ${axisName}`}
                value={option.name}
                onChange={(event) => onRenameOption(option.id, event.target.value)}
                onKeyDown={keepEnter}
                maxLength={VARIANT_LIMITS.optionNameLength}
                disabled={disabled}
                className="w-24 px-1.5 py-1 bg-transparent rounded text-sm focus:outline-none focus:ring-2 focus:ring-yappr-500"
              />
              <button type="button" aria-label={`Move ${optionName} earlier`} onClick={() => onMoveOption(option.id, -1)} disabled={disabled || optionIndex === 0} className={iconButtonClass}>
                <ArrowLeftIcon className="h-3.5 w-3.5" />
              </button>
              <button type="button" aria-label={`Move ${optionName} later`} onClick={() => onMoveOption(option.id, 1)} disabled={disabled || optionIndex === axis.options.length - 1} className={iconButtonClass}>
                <ArrowRightIcon className="h-3.5 w-3.5" />
              </button>
              <button type="button" aria-label={`Remove ${optionName}`} onClick={() => onRemoveOption(option.id)} disabled={disabled || (axis.options.length === 1 && !canRemoveLastOption)} className={iconButtonClass}>
                <XMarkIcon className="h-3.5 w-3.5" />
              </button>
            </li>
          )
        })}
      </ul>

      <div className="flex gap-2">
        <input
          type="text"
          aria-label={`Add options to ${axisName}, separated by commas`}
          value={newOptions}
          onChange={(event) => setNewOptions(event.target.value)}
          onKeyDown={onEnter(handleAdd)}
          placeholder="Add options (e.g., XL, XXL)"
          disabled={disabled}
          className={`${fieldClass} flex-1 min-w-0 bg-white dark:bg-gray-800`}
        />
        <Button type="button" size="sm" variant="outline" onClick={handleAdd} disabled={disabled || names.length === 0}>
          <PlusIcon className="h-4 w-4 mr-1" />
          Add
        </Button>
      </div>
    </div>
  )
}

interface CombinationRowProps {
  combination: VariantCombination
  label: string
  currency: string
  trackStock: boolean
  showWeight: boolean
  perCombinationStock?: boolean
  imageUrls: string[]
  disabled: boolean
  onUpdate: (patch: Partial<CombinationData>) => void
  onRemove: () => void
}

function CombinationRow({ combination, label, currency, trackStock, showWeight, perCombinationStock = false, imageUrls, disabled, onUpdate, onRemove }: CombinationRowProps) {
  const imageUrl = combination.image ? imageUrls[combination.image - 1] : undefined
  return (
    <tr>
      <td className="px-3 py-2 font-medium min-w-[8rem]">{label}</td>
      <td className="px-3 py-2">
        <DraftInput
          type="text"
          aria-label={`Price for ${label} (${currency})`}
          value={formatPriceInput(combination.price, currency)}
          onDraft={(text) => {
            const price = parsePriceInput(text, currency)
            if (price === undefined) return false
            onUpdate({ price })
            return true
          }}
          placeholder={formatPriceInput(0, currency)}
          disabled={disabled}
          className={`${cellClass} w-28`}
        />
      </td>
      {trackStock && (
        <td className="px-3 py-2">
          <DraftInput
            type="text"
            inputMode="numeric"
            aria-label={`Stock for ${label}`}
            value={combination.stock === undefined ? '' : String(combination.stock)}
            onDraft={(text) => {
              if (perCombinationStock && text.trim() === '') {
                onUpdate({ stock: undefined })
                return true
              }
              const stock = parseCountInput(text, VARIANT_LIMITS.maxStock)
              if (stock === undefined) return false
              onUpdate({ stock })
              return true
            }}
            placeholder={perCombinationStock ? 'Not tracked' : '0'}
            disabled={disabled}
            className={`${cellClass} w-20`}
          />
        </td>
      )}
      <td className="px-3 py-2">
        <input
          type="text"
          aria-label={`SKU for ${label}`}
          value={combination.sku ?? ''}
          onChange={(event) => onUpdate({ sku: event.target.value || undefined })}
          onKeyDown={keepEnter}
          placeholder="Optional"
          maxLength={VARIANT_LIMITS.skuLength}
          disabled={disabled}
          className={`${cellClass} w-28`}
        />
      </td>
      {showWeight && (
        <td className="px-3 py-2">
          <DraftInput
            type="text"
            inputMode="numeric"
            aria-label={`Weight in grams for ${label}`}
            value={combination.weight === undefined ? '' : String(combination.weight)}
            onDraft={(text) => {
              if (!text.trim()) {
                onUpdate({ weight: undefined })
                return true
              }
              const weight = parseCountInput(text, VARIANT_LIMITS.maxWeight)
              if (weight === undefined) return false
              onUpdate({ weight: weight || undefined })
              return true
            }}
            placeholder="Default"
            disabled={disabled}
            className={`${cellClass} w-20`}
          />
        </td>
      )}
      {imageUrls.length > 0 && (
        <td className="px-3 py-2">
          <div className="flex items-center gap-2">
            <select
              aria-label={`Image for ${label}`}
              value={combination.image ?? ''}
              onChange={(event) => onUpdate({ image: event.target.value ? Number(event.target.value) : undefined, imageUrl: undefined })}
              disabled={disabled}
              className={`${cellClass} py-1`}
            >
              <option value="">Default image</option>
              {imageUrls.map((url, index) => (
                <option key={`${index}-${url}`} value={index + 1}>Image {index + 1}</option>
              ))}
            </select>
            {imageUrl && (
              <IpfsImage src={imageUrl} alt="" className="h-8 w-8 rounded object-cover flex-shrink-0" />
            )}
          </div>
        </td>
      )}
      <td className="px-2 py-2">
        <button
          type="button"
          aria-label={`Stop offering ${label}`}
          onClick={onRemove}
          disabled={disabled}
          className="p-1 text-red-500 hover:bg-red-100 dark:hover:bg-red-900/30 rounded disabled:opacity-30"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      </td>
    </tr>
  )
}
