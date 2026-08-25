'use client'

import { logger } from '@/lib/logger';
import { useState, useRef, useCallback } from 'react'
import { motion } from 'framer-motion'
import {
  XMarkIcon,
  ArrowUpTrayIcon,
  DocumentTextIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  ArrowDownTrayIcon
} from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { formatPrice } from '@/lib/utils/format'
import {
  parseInventoryCSV,
  toStoreItemData,
  generateCSVTemplate,
  type GroupedInventoryItem,
  type InventoryParseError
} from '@/lib/upload/inventory-parser'
import { storeItemService } from '@/lib/services/store-item-service'

interface InventoryUploadModalProps {
  isOpen: boolean
  onClose: () => void
  storeId: string
  ownerId: string
  onComplete: (addedCount: number) => void
  currency?: string
}

type UploadStep = 'select' | 'preview' | 'uploading' | 'complete'

export function InventoryUploadModal({
  isOpen,
  onClose,
  storeId,
  ownerId,
  onComplete,
  currency = 'USD'
}: InventoryUploadModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isUploadingRef = useRef(false)
  const [step, setStep] = useState<UploadStep>('select')
  const [fileName, setFileName] = useState('')
  const [items, setItems] = useState<GroupedInventoryItem[]>([])
  const [errors, setErrors] = useState<InventoryParseError[]>([])
  const [warnings, setWarnings] = useState<InventoryParseError[]>([])
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadedCount, setUploadedCount] = useState(0)
  const [uploadErrors, setUploadErrors] = useState<string[]>([])

  const resetState = useCallback(() => {
    setStep('select')
    setFileName('')
    setItems([])
    setErrors([])
    setWarnings([])
    setUploadProgress(0)
    setUploadedCount(0)
    setUploadErrors([])
    isUploadingRef.current = false
  }, [])

  const handleClose = useCallback(() => {
    resetState()
    onClose()
  }, [resetState, onClose])

  const handleFileSelect = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setFileName(file.name)

    try {
      const content = await file.text()
      const result = parseInventoryCSV(content, currency)

      setItems(result.items)
      setErrors(result.errors)
      setWarnings(result.warnings)
      setStep('preview')
    } catch (err) {
      logger.error('Failed to parse CSV:', err)
      // Clear any stale preview state before showing error
      setItems([])
      setWarnings([])
      setErrors([{ row: 0, message: `Failed to read file: ${err instanceof Error ? err.message : 'Unknown error'}` }])
      setStep('preview')
    }

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }, [currency])

  const handleUpload = useCallback(async () => {
    // Re-entry guard to prevent concurrent uploads
    if (isUploadingRef.current) return
    if (items.length === 0) return

    isUploadingRef.current = true

    try {
      setStep('uploading')
      setUploadProgress(0)
      setUploadedCount(0)
      setUploadErrors([])

      const newErrors: string[] = []
      let successCount = 0

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        try {
          const data = toStoreItemData(item)
          await storeItemService.createItem(ownerId, storeId, data)
          successCount++
        } catch (err) {
          logger.error(`Failed to upload item ${item.title}:`, err)
          newErrors.push(`${item.title}: ${err instanceof Error ? err.message : 'Upload failed'}`)
        }

        setUploadProgress(Math.round(((i + 1) / items.length) * 100))
        setUploadedCount(successCount)
      }

      setUploadErrors(newErrors)
      setStep('complete')
      onComplete(successCount)
    } finally {
      isUploadingRef.current = false
    }
  }, [items, ownerId, storeId, onComplete])

  const handleDownloadTemplate = useCallback(() => {
    const csv = generateCSVTemplate()
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'inventory-template.csv'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }, [])

  const handleBackdropClick = useCallback(() => {
    if (step === 'uploading') return
    handleClose()
  }, [step, handleClose])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className={`absolute inset-0 bg-black/50 ${step === 'uploading' ? 'cursor-not-allowed' : ''}`}
        onClick={handleBackdropClick}
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative w-full max-w-2xl bg-white dark:bg-gray-900 rounded-xl shadow-xl max-h-[90vh] overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-lg font-bold">Upload Inventory</h2>
          <button
            onClick={step === 'uploading' ? undefined : handleClose}
            disabled={step === 'uploading'}
            aria-label="Close upload modal"
            aria-disabled={step === 'uploading'}
            className={`p-2 rounded-full ${
              step === 'uploading'
                ? 'opacity-50 cursor-not-allowed'
                : 'hover:bg-gray-100 dark:hover:bg-gray-800'
            }`}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {step === 'select' && (
            <div className="space-y-6">
              {/* File Upload Area */}
              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-8 text-center cursor-pointer hover:border-yappr-500 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
              >
                <ArrowUpTrayIcon className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                <p className="text-lg font-medium mb-2">Click to select a CSV file</p>
                <p className="text-sm text-gray-500">
                  Supported format: .csv
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleFileSelect}
                  className="hidden"
                />
              </div>

              {/* Template Download */}
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
                <h3 className="font-medium mb-2">Need a template?</h3>
                <p className="text-sm text-gray-500 mb-3">
                  Download our CSV template with example data to get started quickly.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownloadTemplate}
                  className="flex items-center gap-2"
                >
                  <ArrowDownTrayIcon className="h-4 w-4" />
                  Download Template
                </Button>
              </div>

              {/* Format Info */}
              <div className="text-sm text-gray-500 space-y-2">
                <h3 className="font-medium text-gray-700 dark:text-gray-300">CSV Format</h3>
                <p>Your CSV should include these columns:</p>
                <ul className="list-disc list-inside space-y-1 pl-2">
                  <li><strong>Item Name</strong> (required) - Product title</li>
                  <li><strong>Price</strong> (required) - Price in dollars (e.g., 9.99)</li>
                  <li><strong>Group</strong> - Group ID to link variants together</li>
                  <li><strong>Variant / Sub Variant</strong> - Variant options (e.g., Color, Size)</li>
                  <li><strong>Quantity</strong> - Stock count or formula (e.g., &quot;(SKU-NAME)*5&quot;)</li>
                  <li><strong>SKU, Category, Tags, Images</strong> - Optional fields</li>
                </ul>
              </div>
            </div>
          )}

          {step === 'preview' && (
            <div className="space-y-4">
              {/* File Info */}
              <div className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                <DocumentTextIcon className="h-8 w-8 text-gray-400" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{fileName}</p>
                  <p className="text-sm text-gray-500">
                    {items.length} item{items.length !== 1 ? 's' : ''} found
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={resetState}
                >
                  Change File
                </Button>
              </div>

              {/* Errors */}
              {errors.length > 0 && (
                <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <ExclamationCircleIcon className="h-5 w-5 text-red-500" />
                    <span className="font-medium text-red-800 dark:text-red-200">
                      {errors.length} error{errors.length !== 1 ? 's' : ''} found
                    </span>
                  </div>
                  <ul className="text-sm text-red-700 dark:text-red-300 space-y-1">
                    {errors.slice(0, 5).map((error, i) => (
                      <li key={i}>
                        Row {error.row}: {error.message}
                      </li>
                    ))}
                    {errors.length > 5 && (
                      <li className="text-red-500">...and {errors.length - 5} more</li>
                    )}
                  </ul>
                </div>
              )}

              {/* Warnings */}
              {warnings.length > 0 && (
                <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <ExclamationTriangleIcon className="h-5 w-5 text-yellow-500" />
                    <span className="font-medium text-yellow-800 dark:text-yellow-200">
                      {warnings.length} warning{warnings.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <ul className="text-sm text-yellow-700 dark:text-yellow-300 space-y-1">
                    {warnings.slice(0, 3).map((warning, i) => (
                      <li key={i}>
                        Row {warning.row}: {warning.message}
                      </li>
                    ))}
                    {warnings.length > 3 && (
                      <li className="text-yellow-600">...and {warnings.length - 3} more</li>
                    )}
                  </ul>
                </div>
              )}

              {/* Items Preview */}
              {items.length > 0 && (
                <div>
                  <h3 className="font-medium mb-3">Items to Upload</h3>
                  <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                    <div className="max-h-64 overflow-y-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 dark:bg-gray-800 sticky top-0">
                          <tr>
                            <th className="text-left px-3 py-2 font-medium">Item</th>
                            <th className="text-left px-3 py-2 font-medium">Variants</th>
                            <th className="text-right px-3 py-2 font-medium">Price</th>
                            <th className="text-right px-3 py-2 font-medium">Stock</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                          {items.map((item, i) => (
                            <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                              <td className="px-3 py-2">
                                <div className="font-medium truncate max-w-[200px]">{item.title}</div>
                                {item.category && (
                                  <div className="text-xs text-gray-500">{item.category}</div>
                                )}
                              </td>
                              <td className="px-3 py-2 text-gray-500">
                                {item.variants ? (
                                  <span>{item.variants.combinations.length} variants</span>
                                ) : (
                                  <span>-</span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right">
                                {item.variants ? (
                                  <span>
                                    {formatPrice(Math.min(...item.variants.combinations.map(c => c.price)), currency)}
                                    {' - '}
                                    {formatPrice(Math.max(...item.variants.combinations.map(c => c.price)), currency)}
                                  </span>
                                ) : (
                                  formatPrice(item.basePrice, currency)
                                )}
                              </td>
                              <td className="px-3 py-2 text-right">
                                {item.variants ? (
                                  <span>
                                    {item.variants.combinations.reduce((sum, c) => sum + (c.stock ?? 0), 0)}
                                  </span>
                                ) : (
                                  item.stockQuantity ?? '-'
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 'uploading' && (
            <div className="py-8 text-center">
              <div className="relative w-24 h-24 mx-auto mb-6">
                <svg className="w-full h-full -rotate-90">
                  <circle
                    cx="48"
                    cy="48"
                    r="44"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="8"
                    className="text-gray-200 dark:text-gray-700"
                  />
                  <circle
                    cx="48"
                    cy="48"
                    r="44"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="8"
                    strokeDasharray={276.46}
                    strokeDashoffset={276.46 - (276.46 * uploadProgress) / 100}
                    strokeLinecap="round"
                    className="text-yappr-500 transition-all duration-300"
                  />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-2xl font-bold">{uploadProgress}%</span>
                </div>
              </div>
              <p className="text-lg font-medium mb-2">Uploading Items...</p>
              <p className="text-gray-500">
                {uploadedCount} of {items.length} items uploaded
              </p>
            </div>
          )}

          {step === 'complete' && (
            <div className="py-8 text-center">
              <CheckCircleIcon className="h-16 w-16 text-green-500 mx-auto mb-4" />
              <h3 className="text-xl font-bold mb-2">Upload Complete</h3>
              <p className="text-gray-500 mb-4">
                Successfully uploaded {uploadedCount} of {items.length} items
              </p>

              {uploadErrors.length > 0 && (
                <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-left mb-4">
                  <p className="font-medium text-red-800 dark:text-red-200 mb-2">
                    {uploadErrors.length} item{uploadErrors.length !== 1 ? 's' : ''} failed to upload:
                  </p>
                  <ul className="text-sm text-red-700 dark:text-red-300 space-y-1">
                    {uploadErrors.slice(0, 5).map((error, i) => (
                      <li key={i}>{error}</li>
                    ))}
                    {uploadErrors.length > 5 && (
                      <li>...and {uploadErrors.length - 5} more</li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-4 border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
          {step === 'select' && (
            <Button
              variant="outline"
              className="flex-1"
              onClick={handleClose}
            >
              Cancel
            </Button>
          )}

          {step === 'preview' && (
            <>
              <Button
                variant="outline"
                className="flex-1"
                onClick={handleClose}
              >
                Cancel
              </Button>
              <Button
                className="flex-1"
                onClick={handleUpload}
                disabled={items.length === 0 || errors.length > 0}
              >
                Upload {items.length} Item{items.length !== 1 ? 's' : ''}
              </Button>
            </>
          )}

          {step === 'uploading' && (
            <Button
              variant="outline"
              className="flex-1"
              disabled
            >
              Uploading...
            </Button>
          )}

          {step === 'complete' && (
            <Button
              className="flex-1"
              onClick={handleClose}
            >
              Done
            </Button>
          )}
        </div>
      </motion.div>
    </div>
  )
}
