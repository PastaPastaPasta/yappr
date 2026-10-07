'use client'

import { logger } from '@/lib/logger'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import Link from 'next/link'
import { ArrowUpTrayIcon, DocumentIcon, KeyIcon, LinkIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { getUploadErrorMessage, isUploadException, UploadErrorCode } from '@/lib/upload'
import { formatFileSize, uploadEncryptedFile } from '@/lib/services/digital-file-service'
import { isSafeDeliveryUrl, MAX_CODE_LENGTH, MAX_DIGITAL_FILE_BYTES, normalizeLinkInput } from '@/lib/services/digital-delivery-plan'
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
  /** Editing what one order gets, rather than what every buyer of the product gets. */
  forOneOrder?: boolean
}

const assetLabel = (asset: DigitalAsset) => asset.kind === 'file' ? asset.name : asset.label

/** The line under an asset's label: what the seller saved, as the buyer will get it. */
function assetDetail(asset: DigitalAsset): string {
  if (asset.kind === 'file') return `${formatFileSize(asset.size)} · encrypted on IPFS`
  if (asset.kind === 'code') return asset.code
  return asset.code ? `${asset.url} · code ${asset.code}` : asset.url
}

const ASSET_ICONS = { link: LinkIcon, code: KeyIcon, file: DocumentIcon } as const

type AddMode = keyof typeof ASSET_ICONS

const ADD_MODES: Array<{ mode: AddMode; label: string }> = [
  { mode: 'link', label: 'Link' },
  { mode: 'code', label: 'Code' },
  { mode: 'file', label: 'File' },
]

const inputClass = 'px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500 text-sm'

/** Secrets: kept out of autofill history and the browser's (possibly cloud) spellcheck. */
const secretInputProps = { autoComplete: 'off', spellCheck: false } as const

/**
 * Enter adds the entry. The editor sits inside the product form, where Enter
 * would otherwise submit the product and drop what was typed here.
 */
const addOnEnter = (add: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key !== 'Enter') return
  e.preventDefault()
  add()
}

/**
 * What a digital product (or one order) delivers. Most sellers already host
 * their goods somewhere, so links come first: any https URL (secret query
 * string and all), optionally with the access code or password it asks for.
 * Codes are text to copy (a voucher, a login, an invite). Files are optional
 * and need an IPFS storage provider: they are encrypted in the browser and
 * only the ciphertext is uploaded; the key lives in the asset, which is itself
 * only ever stored encrypted.
 */
export function DigitalAssetListEditor({ assets, onChange, identityId, variantKeys = [], disabled = false, onBusyChange, forOneOrder = false }: DigitalAssetListEditorProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [upload, setUpload] = useState<{ name: string; progress: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [needsProvider, setNeedsProvider] = useState(false)
  const [mode, setMode] = useState<AddMode>('link')
  const [label, setLabel] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [code, setCode] = useState('')
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

  const resetForm = () => {
    setLabel('')
    setLinkUrl('')
    setCode('')
    setError(null)
  }

  const handleAddLink = () => {
    if (!linkUrl.trim()) return
    const url = normalizeLinkInput(linkUrl)
    if (!isSafeDeliveryUrl(url)) {
      setError('Links must start with https://, http://, magnet: or ipfs://. Send any other kind of address as a code.')
      return
    }
    const accessCode = code.trim()
    const asset: DigitalAsset = { kind: 'link', label: label.trim() || url, url, ...(accessCode ? { code: accessCode } : {}) }
    onChange((current) => [...current, asset])
    resetForm()
  }

  const handleAddCode = () => {
    const text = code.trim()
    if (!text) return
    onChange((current) => [...current, { kind: 'code', label: label.trim() || 'Code', code: text }])
    resetForm()
  }

  // Each tab starts empty: a code typed under Code must not become a link's access code.
  const switchMode = (next: AddMode) => {
    setMode(next)
    resetForm()
    setNeedsProvider(false)
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
          {assets.map((asset, index) => {
            const Icon = ASSET_ICONS[asset.kind]
            return (
              <li key={`${asset.kind}-${assetLabel(asset)}-${index}`} className="flex items-center gap-3 p-3">
                <Icon className="h-5 w-5 text-gray-400 flex-shrink-0" aria-hidden="true" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{assetLabel(asset)}</p>
                  <p className="text-xs text-gray-500 truncate">{assetDetail(asset)}</p>
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
            )
          })}
        </ul>
      )}

      <div role="group" aria-label="Kind of content to add" className="inline-flex rounded-lg border border-gray-200 dark:border-gray-800 p-0.5">
        {ADD_MODES.map((option) => (
          <button
            key={option.mode}
            type="button"
            aria-pressed={mode === option.mode}
            onClick={() => switchMode(option.mode)}
            // The upload's progress shows on the File tab: stay there until it ends.
            disabled={disabled || isUploading}
            className={`px-3 py-1 text-sm rounded-md transition-colors ${
              mode === option.mode ? 'bg-yappr-500 text-white' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {mode === 'link' && (
        <div className="space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr] gap-2">
            <input
              type="text"
              aria-label="Link label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={addOnEnter(handleAddLink)}
              placeholder="Label (e.g., Download)"
              maxLength={100}
              disabled={disabled}
              className={inputClass}
            />
            <input
              type="url"
              aria-label="Link URL"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={addOnEnter(handleAddLink)}
              {...secretInputProps}
              placeholder="https://… (your site, Drive, Dropbox, a course portal)"
              disabled={disabled}
              className={inputClass}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
            <input
              type="text"
              aria-label="Access code or password for the link"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={addOnEnter(handleAddLink)}
              {...secretInputProps}
              placeholder="Access code or password (optional)"
              maxLength={MAX_CODE_LENGTH}
              disabled={disabled}
              className={inputClass}
            />
            <Button type="button" variant="outline" size="sm" onClick={handleAddLink} disabled={disabled || !linkUrl.trim()}>
              <PlusIcon className="h-4 w-4 mr-1" />
              Add link
            </Button>
          </div>
          <p className="text-xs text-gray-500">
            Any https link works, including one with a secret in it (…?q=code). Buyers only see it once you deliver, encrypted to them.
          </p>
        </div>
      )}

      {mode === 'code' && (
        <div className="space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-2">
            <input
              type="text"
              aria-label="Code label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={addOnEnter(handleAddCode)}
              placeholder="Label (e.g., Voucher)"
              maxLength={100}
              disabled={disabled}
              className={inputClass}
            />
            <input
              type="text"
              aria-label="Code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={addOnEnter(handleAddCode)}
              {...secretInputProps}
              placeholder="Code, password or invite"
              maxLength={MAX_CODE_LENGTH}
              disabled={disabled}
              className={`${inputClass} font-mono`}
            />
            <Button type="button" variant="outline" size="sm" onClick={handleAddCode} disabled={disabled || !code.trim()}>
              <PlusIcon className="h-4 w-4 mr-1" />
              Add code
            </Button>
          </div>
          {!forOneOrder && (
            <p className="text-xs text-gray-500">Every buyer gets this same code. For a different one per buyer, use unique codes below.</p>
          )}
        </div>
      )}

      {mode === 'file' && (
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
            Optional: needs IPFS storage connected in Settings. Up to {formatFileSize(MAX_DIGITAL_FILE_BYTES)} each, encrypted on this device before upload; only buyers you deliver to get the key.
          </p>
        </div>
      )}

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
