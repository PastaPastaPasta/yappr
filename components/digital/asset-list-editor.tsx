'use client'

import { logger } from '@/lib/logger'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowUpTrayIcon, DocumentIcon, LinkIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { getUploadErrorMessage, isUploadException, UploadErrorCode } from '@/lib/upload'
import { formatFileSize, uploadEncryptedFile } from '@/lib/services/digital-file-service'
import { isSafeDeliveryUrl, MAX_DIGITAL_FILE_BYTES } from '@/lib/services/digital-delivery-plan'
import type { DigitalAsset } from '@/lib/types'

interface DigitalAssetListEditorProps {
  assets: DigitalAsset[]
  /**
   * Receives an updater, not a value: an upload can run for minutes, and
   * applying its result to the list as it stands THEN keeps any edit the
   * seller made meanwhile.
   */
  onChange: (update: (assets: DigitalAsset[]) => DigitalAsset[]) => void
  identityId: string
  /** The item's variant keys; when given, each asset can be limited to one of them. */
  variantKeys?: string[]
  disabled?: boolean
  /**
   * Told when an upload starts and ends. A file's key reaches `assets` only
   * when its upload finishes, so the parent must not save or send until then.
   */
  onBusyChange?: (busy: boolean) => void
}

const assetLabel = (asset: DigitalAsset) => asset.kind === 'file' ? asset.name : asset.label

const inputClass = 'px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500 text-sm'

/**
 * Files and links for a digital product. Files are encrypted in the browser
 * and only the ciphertext is uploaded (to the identity's IPFS provider); the
 * key lives in the asset, which is itself only ever stored encrypted.
 */
export function DigitalAssetListEditor({ assets, onChange, identityId, variantKeys = [], disabled = false, onBusyChange }: DigitalAssetListEditorProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [upload, setUpload] = useState<{ name: string; progress: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [needsProvider, setNeedsProvider] = useState(false)
  const [linkLabel, setLinkLabel] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const isUploading = upload !== null

  // Through a ref, so a parent passing an inline callback does not re-fire these.
  const onBusyChangeRef = useRef(onBusyChange)
  useEffect(() => {
    onBusyChangeRef.current = onBusyChange
  }, [onBusyChange])
  useEffect(() => {
    onBusyChangeRef.current?.(isUploading)
  }, [isUploading])
  // An editor that unmounts mid-upload never reports the end; release the parent.
  useEffect(() => () => onBusyChangeRef.current?.(false), [])

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setError(null)
    setNeedsProvider(false)
    try {
      for (const file of Array.from(files)) {
        setUpload({ name: file.name, progress: 0 })
        const asset = await uploadEncryptedFile(identityId, file, (progress) => setUpload({ name: file.name, progress }))
        onChange((current) => [...current, asset])
      }
    } catch (err) {
      logger.error('Digital file upload failed:', err)
      setNeedsProvider(isUploadException(err) && err.code === UploadErrorCode.NOT_CONNECTED)
      setError(getUploadErrorMessage(err))
    } finally {
      setUpload(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleAddLink = () => {
    const url = linkUrl.trim()
    if (!isSafeDeliveryUrl(url)) {
      setError('Links must start with https://, http:// or ipfs://')
      return
    }
    setError(null)
    const label = linkLabel.trim() || url
    onChange((current) => [...current, { kind: 'link', label, url }])
    setLinkLabel('')
    setLinkUrl('')
  }

  const setVariant = (index: number, variantKey: string) => {
    onChange((current) => current.map((asset, i) => {
      if (i !== index) return asset
      const copy = { ...asset }
      if (variantKey) copy.variantKey = variantKey
      else delete copy.variantKey
      return copy
    }))
  }

  return (
    <div className="space-y-3">
      {assets.length > 0 && (
        <ul className="divide-y divide-gray-200 dark:divide-gray-800 border border-gray-200 dark:border-gray-800 rounded-lg">
          {assets.map((asset, index) => (
            <li key={`${asset.url}-${index}`} className="flex items-center gap-3 p-3">
              {asset.kind === 'file'
                ? <DocumentIcon className="h-5 w-5 text-gray-400 flex-shrink-0" aria-hidden="true" />
                : <LinkIcon className="h-5 w-5 text-gray-400 flex-shrink-0" aria-hidden="true" />}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{assetLabel(asset)}</p>
                <p className="text-xs text-gray-500 truncate">
                  {asset.kind === 'file' ? `${formatFileSize(asset.size)} · encrypted on IPFS` : asset.url}
                </p>
              </div>
              {variantKeys.length > 0 && (
                <select
                  aria-label={`Variant for ${assetLabel(asset)}`}
                  value={asset.variantKey ?? ''}
                  onChange={(e) => setVariant(index, e.target.value)}
                  disabled={disabled}
                  className={`${inputClass} max-w-[40%]`}
                >
                  <option value="">All variants</option>
                  {variantKeys.map((key) => (
                    <option key={key} value={key}>{key.replace(/\|/g, ' / ')}</option>
                  ))}
                </select>
              )}
              <button
                type="button"
                aria-label={`Remove ${assetLabel(asset)}`}
                onClick={() => onChange((current) => current.filter((_, i) => i !== index))}
                disabled={disabled}
                className="p-1 text-red-500 hover:bg-red-100 dark:hover:bg-red-900/30 rounded disabled:opacity-50"
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          aria-label="Choose files to sell"
          onChange={(e) => { handleFiles(e.target.files).catch((err) => logger.error(err)) }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || upload !== null}
        >
          <ArrowUpTrayIcon className="h-4 w-4 mr-1.5" />
          {upload ? `Encrypting & uploading ${upload.name} (${upload.progress}%)` : 'Upload files'}
        </Button>
        <p className="text-xs text-gray-500 mt-1">
          Up to {formatFileSize(MAX_DIGITAL_FILE_BYTES)} each. Files are encrypted on this device before upload; only buyers you deliver to get the key.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-2">
        <input
          type="text"
          aria-label="Link label"
          value={linkLabel}
          onChange={(e) => setLinkLabel(e.target.value)}
          placeholder="Label (e.g., Course portal)"
          maxLength={100}
          disabled={disabled}
          className={inputClass}
        />
        <input
          type="url"
          aria-label="Link URL"
          value={linkUrl}
          onChange={(e) => setLinkUrl(e.target.value)}
          placeholder="https://…"
          disabled={disabled}
          className={inputClass}
        />
        <Button type="button" variant="outline" size="sm" onClick={handleAddLink} disabled={disabled || !linkUrl.trim()}>
          <PlusIcon className="h-4 w-4 mr-1" />
          Add link
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
          {needsProvider && (
            <>
              {' '}
              <Link href="/settings?section=storage" className="underline">Connect storage</Link>
            </>
          )}
        </p>
      )}
    </div>
  )
}
