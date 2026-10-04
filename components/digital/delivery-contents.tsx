'use client'

import { logger } from '@/lib/logger'
import { useState } from 'react'
import { ArrowDownTrayIcon, ArrowTopRightOnSquareIcon, ClipboardIcon, DocumentIcon, KeyIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui/button'
import { fetchDecryptedFile, formatFileSize, saveBlob, type DigitalFileAsset } from '@/lib/services/digital-file-service'
import { splitPoolEntry } from '@/lib/services/digital-delivery-plan'
import { ipfsToGatewayUrl } from '@/lib/utils/ipfs-gateway'
import { formatDate } from '@/lib/utils/format'
import type { OrderDelivery, OrderDeliveryPayload } from '@/lib/types'

function FileRow({ asset }: { asset: DigitalFileAsset }) {
  const [isDownloading, setIsDownloading] = useState(false)

  const handleDownload = async () => {
    setIsDownloading(true)
    try {
      saveBlob(await fetchDecryptedFile(asset), asset.name)
    } catch (error) {
      logger.error('Digital file download failed:', error)
      toast.error(error instanceof Error ? error.message : 'Download failed')
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <li className="flex items-center gap-3">
      <DocumentIcon className="h-5 w-5 text-gray-400 flex-shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{asset.name}</p>
        <p className="text-xs text-gray-500">{formatFileSize(asset.size)}</p>
      </div>
      <Button size="sm" variant="outline" onClick={() => { handleDownload().catch((error) => logger.error(error)) }} disabled={isDownloading}>
        <ArrowDownTrayIcon className="h-4 w-4 mr-1" />
        {isDownloading ? 'Decrypting…' : 'Download'}
      </Button>
    </li>
  )
}

function copy(text: string, label: string) {
  navigator.clipboard.writeText(text)
    .then(() => toast.success(`${label} copied`))
    .catch(() => toast.error('Failed to copy'))
}

/** `label` names what is copied, in the toast; `name` tells this button apart from its neighbours. */
function CopyButton({ text, label, name }: { text: string; label: string; name: string }) {
  return (
    <button
      type="button"
      aria-label={`Copy ${name}`}
      onClick={() => copy(text, label)}
      className="p-1 text-gray-500 hover:text-yappr-500 flex-shrink-0"
    >
      <ClipboardIcon className="h-4 w-4" />
    </button>
  )
}

/** A link the buyer opens, with a copy button (and its access code, when it has one). */
function LinkRow({ label, url, code }: { label: string; url: string; code?: string }) {
  // A magnet link hands off to the torrent client; a new tab would stay blank.
  const opensPage = !url.toLowerCase().startsWith('magnet:')
  return (
    <li className="space-y-1">
      <div className="flex items-center gap-2">
        <a
          // ipfs:// links open through a gateway (other URLs come back as themselves);
          // decodeDelivery already refused any scheme but http(s), magnet and ipfs.
          // A public gateway: the buyer's own dedicated one serves only their pins. Other URLs pass through.
          href={ipfsToGatewayUrl(url)}
          {...(opensPage ? { target: '_blank' } : {})}
          rel="noopener noreferrer nofollow"
          className="inline-flex items-center gap-1.5 text-sm text-yappr-600 hover:underline break-all min-w-0"
        >
          <ArrowTopRightOnSquareIcon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          {label}
        </a>
        <CopyButton text={url} label="Link" name={`link to ${label}`} />
      </div>
      {code && <CodeRow label="Access code" code={code} name={`access code for ${label}`} />}
    </li>
  )
}

/** Text to copy: an access code, a voucher, a license key. */
function CodeRow({ label, code, name = label }: { label: string; code: string; name?: string }) {
  return (
    <div className="flex items-center gap-2">
      <KeyIcon className="h-4 w-4 text-gray-400 flex-shrink-0" aria-hidden="true" />
      <span className="text-xs text-gray-500 flex-shrink-0">{label}:</span>
      <code className="flex-1 min-w-0 text-sm font-mono break-all">{code}</code>
      <CopyButton text={code} label={label} name={name} />
    </div>
  )
}

/** The buyer's own codes (one per unit): links, links with their own code, or codes. */
function UniqueCodes({ entries }: { entries: string[] }) {
  const parsed = entries.map(splitPoolEntry)
  const codeCount = parsed.filter((entry) => !entry.url).length
  let codeNumber = 0
  return (
    <ul className="space-y-1">
      {parsed.map((entry, index) => {
        if (entry.url) return <LinkRow key={index} label={entry.url} url={entry.url} code={entry.code} />
        codeNumber++
        const label = codeCount === 1 ? 'Your code' : `Code ${codeNumber}`
        return <li key={index}><CodeRow label={label} code={entry.code ?? ''} /></li>
      })}
    </ul>
  )
}

/** One delivery's goods: links, codes, downloads, unique codes and the seller's notes. */
function DeliveryBody({ payload }: { payload: OrderDeliveryPayload }) {
  return (
    <div className="space-y-3">
      {payload.items.map((item, index) => (
        <div key={`${item.itemId}-${item.variantKey ?? ''}-${index}`} className="space-y-2">
          <p className="text-sm font-medium">
            {item.itemTitle}
            {item.variantKey && <span className="text-gray-500 font-normal"> ({item.variantKey.replace(/\|/g, ' / ')})</span>}
          </p>
          {item.assets.length > 0 && (
            <ul className="space-y-2">
              {item.assets.map((asset, assetIndex) => {
                if (asset.kind === 'file') return <FileRow key={assetIndex} asset={asset} />
                if (asset.kind === 'link') return <LinkRow key={assetIndex} label={asset.label} url={asset.url} code={asset.code} />
                return <li key={assetIndex}><CodeRow label={asset.label} code={asset.code} /></li>
              })}
            </ul>
          )}
          {item.licenseKeys && item.licenseKeys.length > 0 && <UniqueCodes entries={item.licenseKeys} />}
          {item.instructions && (
            <p className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap">{item.instructions}</p>
          )}
        </div>
      ))}
      {payload.message && (
        <p className="text-sm italic text-gray-600 dark:text-gray-400 whitespace-pre-wrap border-t border-gray-200 dark:border-gray-800 pt-2">
          {payload.message}
        </p>
      )}
    </div>
  )
}

interface DeliveryContentsProps {
  /** Deliveries for one order, oldest first; only decrypted ones are shown. */
  deliveries: OrderDelivery[]
}

/** Everything delivered for an order, newest first. */
export function DeliveryContents({ deliveries }: DeliveryContentsProps) {
  const readable = deliveries
    .filter((delivery): delivery is OrderDelivery & { payload: OrderDeliveryPayload } => delivery.payload !== undefined)
    .reverse()
  const unreadable = deliveries.length - readable.length
  return (
    <div className="space-y-4">
      {readable.map((delivery) => (
        <div key={delivery.id} className="space-y-2">
          {readable.length > 1 && <p className="text-xs text-gray-500">Delivered {formatDate(delivery.createdAt)}</p>}
          <DeliveryBody payload={delivery.payload} />
        </div>
      ))}
      {unreadable > 0 && (
        <p className="text-sm text-yellow-700 dark:text-yellow-300">
          {unreadable === 1 ? 'One delivery' : `${unreadable} deliveries`} could not be decrypted on this device. Add your encryption key to read {unreadable === 1 ? 'it' : 'them'}; if it is already here, the seller may have changed their key, so ask them to send again.
        </p>
      )}
    </div>
  )
}
