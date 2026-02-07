'use client'

import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { XMarkIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { getCurrencyStep, getCurrencyDecimals, toSmallestUnit, fromSmallestUnit } from '@/lib/utils/format'
import type { ShippingZone, ShippingPricingConfig, SubtotalMultiplier } from '@/lib/types'

type RateType = 'flat' | 'weight_tiered' | 'price_tiered'

interface MultiplierRow {
  id: string
  upTo: string  // Empty string for infinity
  percent: string
}

interface ShippingZoneModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (data: {
    name: string
    rateType: RateType
    flatRate?: number
    tiers?: ShippingPricingConfig
    currency: string
    countryPattern?: string
    priority?: number
  }) => Promise<void>
  zone?: ShippingZone | null
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 9)
}

export function ShippingZoneModal({ isOpen, onClose, onSave, zone }: ShippingZoneModalProps) {
  const [name, setName] = useState('')
  const [rateType, setRateType] = useState<RateType>('flat')
  const [baseRate, setBaseRate] = useState('')
  const [weightRate, setWeightRate] = useState('')
  const [weightUnit, setWeightUnit] = useState('lb')
  const [currency, setCurrency] = useState('USD')
  const [countryPattern, setCountryPattern] = useState('')
  const [isWorldwide, setIsWorldwide] = useState(false)
  const [priority, setPriority] = useState('0')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [multipliers, setMultipliers] = useState<MultiplierRow[]>([])

  const isEditing = !!zone

  // Pre-fill form when editing
  useEffect(() => {
    if (zone) {
      const zoneCurrency = zone.currency || 'USD'
      const decimals = getCurrencyDecimals(zoneCurrency)

      setName(zone.name || '')
      setRateType(zone.rateType || 'flat')
      setBaseRate(zone.flatRate ? fromSmallestUnit(zone.flatRate, zoneCurrency).toFixed(decimals) : '')
      setCurrency(zoneCurrency)
      setCountryPattern(zone.countryPattern || '')
      setIsWorldwide(!zone.countryPattern)
      setPriority(zone.priority?.toString() || '0')

      // Parse existing pricing config from tiers
      if (zone.tiers && !Array.isArray(zone.tiers)) {
        const config = zone.tiers as ShippingPricingConfig
        setWeightRate(config.weightRate ? fromSmallestUnit(config.weightRate, zoneCurrency).toFixed(decimals) : '')
        setWeightUnit(config.weightUnit || 'lb')

        if (config.subtotalMultipliers && config.subtotalMultipliers.length > 0) {
          setMultipliers(config.subtotalMultipliers.map(m => ({
            id: generateId(),
            upTo: m.upTo !== null ? fromSmallestUnit(m.upTo, zoneCurrency).toFixed(decimals) : '',
            percent: m.percent.toString()
          })))
        } else {
          setMultipliers([])
        }
      } else {
        setWeightRate('')
        setWeightUnit('lb')
        setMultipliers([])
      }
    } else {
      // Reset form for new zone
      setName('')
      setRateType('flat')
      setBaseRate('')
      setWeightRate('')
      setWeightUnit('lb')
      setCurrency('USD')
      setCountryPattern('')
      setIsWorldwide(false)
      setPriority('0')
      setMultipliers([])
    }
  }, [zone, isOpen])

  if (!isOpen) return null

  const addMultiplier = () => {
    setMultipliers([...multipliers, { id: generateId(), upTo: '', percent: '100' }])
  }

  const updateMultiplier = (id: string, field: 'upTo' | 'percent', value: string) => {
    setMultipliers(multipliers.map(m =>
      m.id === id ? { ...m, [field]: value } : m
    ))
  }

  const removeMultiplier = (id: string) => {
    setMultipliers(multipliers.filter(m => m.id !== id))
  }

  const handleSubmit = async () => {
    if (!name.trim()) return

    setIsSubmitting(true)
    try {
      const baseRateInSmallestUnit = baseRate ? toSmallestUnit(parseFloat(baseRate), currency) : 0
      const weightRateInSmallestUnit = weightRate ? toSmallestUnit(parseFloat(weightRate), currency) : 0

      // Build combined pricing config if we have weight rate or multipliers
      let tiers: ShippingPricingConfig | undefined
      if (weightRateInSmallestUnit > 0 || multipliers.length > 0) {
        const subtotalMultipliers: SubtotalMultiplier[] = multipliers
          .filter(m => m.percent !== '')
          .map(m => ({
            upTo: m.upTo !== '' ? toSmallestUnit(parseFloat(m.upTo), currency) : null,
            percent: parseInt(m.percent, 10)
          }))
          // Sort by upTo ascending (null goes last)
          .sort((a, b) => {
            if (a.upTo === null) return 1
            if (b.upTo === null) return -1
            return a.upTo - b.upTo
          })

        tiers = {}
        if (weightRateInSmallestUnit > 0) {
          tiers.weightRate = weightRateInSmallestUnit
          tiers.weightUnit = weightUnit
        }
        if (subtotalMultipliers.length > 0) {
          tiers.subtotalMultipliers = subtotalMultipliers
        }
      }

      await onSave({
        name: name.trim(),
        rateType,
        flatRate: baseRateInSmallestUnit || undefined,
        tiers,
        currency,
        countryPattern: isWorldwide ? undefined : (countryPattern.trim() || undefined),
        priority: Math.max(0, priority ? parseInt(priority, 10) : 0)
      })
      // Reset form
      setName('')
      setBaseRate('')
      setWeightRate('')
      setWeightUnit('lb')
      setCountryPattern('')
      setIsWorldwide(false)
      setPriority('0')
      setMultipliers([])
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative w-full max-w-lg bg-white dark:bg-gray-900 rounded-xl shadow-xl max-h-[90vh] overflow-y-auto"
      >
        <div className="sticky top-0 flex items-center justify-between p-4 border-b border-border bg-white dark:bg-gray-900">
          <h2 className="text-lg font-bold">{isEditing ? 'Edit Shipping Zone' : 'Add Shipping Zone'}</h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="p-4 space-y-5">
          {/* Zone Name */}
          <div>
            <label className="block text-sm font-medium mb-2">Zone Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Domestic, Europe, Worldwide"
              className="w-full px-4 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
              maxLength={63}
            />
          </div>

          {/* Country Pattern */}
          <div>
            <label className="block text-sm font-medium mb-2">Region</label>
            <label className="flex items-center gap-2 mb-3 cursor-pointer">
              <input
                type="checkbox"
                checked={isWorldwide}
                onChange={(e) => {
                  setIsWorldwide(e.target.checked)
                  if (e.target.checked) setCountryPattern('')
                }}
                className="w-4 h-4 rounded border-gray-300 text-yappr-500 focus:ring-yappr-500"
              />
              <span className="text-sm">Worldwide (ships to all countries)</span>
            </label>
            {!isWorldwide && (
              <>
                <input
                  type="text"
                  value={countryPattern}
                  onChange={(e) => setCountryPattern(e.target.value)}
                  placeholder="e.g., US, US|CA, US.IL"
                  className="w-full px-4 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Examples: US, US|CA, US.IL (state), US.6 (zip prefix), CA.K (postal prefix)
                </p>
              </>
            )}
          </div>

          {/* Priority */}
          <div>
            <label className="block text-sm font-medium mb-2">Priority</label>
            <input
              type="number"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              onBlur={() => {
                const val = parseInt(priority, 10)
                if (isNaN(val) || val < 0) setPriority('0')
              }}
              placeholder="0"
              min="0"
              className="w-full px-4 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
            />
            <p className="text-xs text-gray-500 mt-1">
              Lower = higher priority. Use to make specific zones (e.g., US.IL) match before general ones (e.g., US).
            </p>
          </div>

          {/* Pricing Section */}
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <h3 className="text-sm font-semibold mb-3 text-gray-700 dark:text-gray-300">PRICING</h3>

            {/* Rate Type (hidden, kept for backwards compat) */}
            <input type="hidden" value={rateType} />

            {/* Base Rate */}
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm font-medium mb-2">Base Rate</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                  <input
                    type="number"
                    value={baseRate}
                    onChange={(e) => setBaseRate(e.target.value)}
                    placeholder="0.00"
                    step={getCurrencyStep(currency)}
                    min="0"
                    className="w-full pl-7 pr-4 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Currency</label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="w-full px-4 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
                >
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                  <option value="GBP">GBP</option>
                  <option value="DASH">DASH</option>
                </select>
              </div>
            </div>

            {/* Weight Rate */}
            <div className="mb-4">
              <label className="block text-sm font-medium mb-2">Weight Rate (optional)</label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                  <input
                    type="number"
                    value={weightRate}
                    onChange={(e) => setWeightRate(e.target.value)}
                    placeholder="0.00"
                    step={getCurrencyStep(currency)}
                    min="0"
                    className="w-full pl-7 pr-4 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">per</span>
                  <select
                    value={weightUnit}
                    onChange={(e) => setWeightUnit(e.target.value)}
                    className="px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
                  >
                    <option value="lb">lb</option>
                    <option value="oz">oz</option>
                    <option value="kg">kg</option>
                    <option value="g">g</option>
                    <option value="item">item</option>
                  </select>
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Additional charge per weight unit. Leave empty for no weight-based pricing.
              </p>
            </div>

            {/* Order Size Multipliers */}
            <div>
              <label className="block text-sm font-medium mb-2">Order Size Multipliers (optional)</label>
              <p className="text-xs text-gray-500 mb-3">
                Scale shipping cost based on order subtotal. 100% = normal, 0% = free shipping.
              </p>

              {multipliers.length > 0 && (
                <div className="space-y-2 mb-3">
                  <div className="grid grid-cols-[1fr_1fr_40px] gap-2 text-xs font-medium text-gray-500">
                    <span>Up to $</span>
                    <span>Charge %</span>
                    <span></span>
                  </div>
                  {multipliers.map((m, index) => (
                    <div key={m.id} className="grid grid-cols-[1fr_1fr_40px] gap-2 items-center">
                      <input
                        type="number"
                        value={m.upTo}
                        onChange={(e) => updateMultiplier(m.id, 'upTo', e.target.value)}
                        placeholder={index === multipliers.length - 1 ? 'Above' : '0.00'}
                        step={getCurrencyStep(currency)}
                        min="0"
                        disabled={index === multipliers.length - 1 && m.upTo === ''}
                        className="w-full px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500 disabled:opacity-50"
                      />
                      <div className="relative">
                        <input
                          type="number"
                          value={m.percent}
                          onChange={(e) => updateMultiplier(m.id, 'percent', e.target.value)}
                          placeholder="100"
                          step="1"
                          min="0"
                          className="w-full px-3 py-2 pr-8 bg-gray-100 dark:bg-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500">%</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeMultiplier(m.id)}
                        className="p-2 hover:bg-red-100 dark:hover:bg-red-900/20 text-red-500 rounded-lg"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={addMultiplier}
                className="flex items-center gap-2 text-sm text-yappr-500 hover:text-yappr-600"
              >
                <PlusIcon className="h-4 w-4" />
                Add tier
              </button>

              {multipliers.length > 0 && (
                <div className="mt-3 p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg text-xs text-gray-600 dark:text-gray-400">
                  <strong>Formula:</strong> shipping = (base + weight x rate) x multiplier%
                  <br />
                  <strong>Tip:</strong> Use 0% for free shipping above a threshold.
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="sticky bottom-0 flex gap-3 p-4 border-t border-border bg-white dark:bg-gray-900">
          <Button
            variant="outline"
            className="flex-1"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            className="flex-1"
            onClick={handleSubmit}
            disabled={isSubmitting || !name.trim()}
          >
            {isSubmitting ? (isEditing ? 'Saving...' : 'Creating...') : (isEditing ? 'Save Changes' : 'Create Zone')}
          </Button>
        </div>
      </motion.div>
    </div>
  )
}
