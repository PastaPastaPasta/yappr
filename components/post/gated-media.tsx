'use client'

import { useCallback, useState } from 'react'
import { EyeSlashIcon, PhotoIcon } from '@heroicons/react/24/outline'
import { logger } from '@/lib/logger'
import { useSettingsStore } from '@/lib/store'
import { checkServedMedia } from '@/lib/media/media-fingerprint'
import { cn } from '@/lib/utils'
import { IpfsImage } from '@/components/ui/ipfs-image'
import { ipfsToGatewayUrl, isIpfsProtocol } from '@/lib/utils/ipfs-gateway'
import type { Media } from '@/lib/types'
import type { MediaGate } from '@/hooks/use-media-gate'

interface GatedMediaPlaceholderProps {
  onReveal: () => void
  /** 'image' renders a full aspect-video block; 'preview' a compact row */
  kind: 'image' | 'preview'
  className?: string
}

/**
 * Frosted stand-in for media from a non-followed author. Renders no remote
 * content at all — the real image is only fetched after the user reveals it
 * (or disables gating in settings).
 */
export function GatedMediaPlaceholder({ onReveal, kind, className }: GatedMediaPlaceholderProps) {
  const potatoMode = useSettingsStore((s) => s.potatoMode)

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800',
        'bg-gradient-to-br from-gray-200 to-gray-300 dark:from-neutral-800 dark:to-neutral-900',
        kind === 'image' ? 'aspect-video w-full' : 'w-full',
        className
      )}
    >
      <div
        className={cn(
          'flex h-full w-full items-center justify-center bg-white/30 dark:bg-black/30',
          !potatoMode && 'backdrop-blur-xl',
          kind === 'image' ? 'flex-col gap-2 p-4' : 'gap-3 px-4 py-3'
        )}
      >
        <EyeSlashIcon className="h-6 w-6 shrink-0 text-neutral-500 dark:text-neutral-400" />
        <p className={cn('text-sm text-neutral-600 dark:text-neutral-400', kind === 'image' && 'text-center')}>
          Media from someone you don&apos;t follow
        </p>
        <button
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onReveal()
          }}
          className="shrink-0 rounded-full bg-neutral-900/80 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-neutral-900 dark:bg-white/90 dark:text-neutral-900 dark:hover:bg-white"
        >
          Show
        </button>
      </div>
    </div>
  )
}

interface GatedPostMediaProps {
  media: Media
  gate: MediaGate
}

/**
 * A post-card media cell: the follow-gate placeholder while gated, otherwise
 * the image itself with IPFS multi-gateway failover, or a v13 video played in
 * place (videos are not checked against their posted hashes).
 *
 * A v10 post names its image's sha256 and dHash. Once the image loads, the
 * served copy is checked against them, and a picture that is no longer the one
 * posted (fingerprint more than 10 bits away) gets a small notice. A check
 * that cannot run (no CORS, undecodable) claims nothing.
 */
export function GatedPostMedia({ media, gate }: GatedPostMediaProps) {
  const [changed, setChanged] = useState(false)
  const hashes = media.hashes
  const handleLoad = useCallback((loadedUrl: string) => {
    if (!hashes) return
    checkServedMedia(loadedUrl, hashes)
      .then((result) => setChanged(result === true))
      .catch((error) => logger.warn('Media fingerprint check failed:', error))
  }, [hashes])

  if (gate.gated) {
    return <GatedMediaPlaceholder kind="image" onReveal={gate.reveal} className="h-full rounded-none border-0" />
  }

  // v13 `mediaKinds` 1: a video, played in place (a GIF is an image).
  if (media.type === 'video') {
    return (
      <video
        src={isIpfsProtocol(media.url) ? ipfsToGatewayUrl(media.url) : media.url}
        controls
        preload="metadata"
        playsInline
        className="absolute inset-0 h-full w-full bg-black object-contain"
        onClick={(event) => event.stopPropagation()}
      />
    )
  }

  return (
    <>
      <IpfsImage
        src={media.url}
        alt={media.alt || ''}
        className="absolute inset-0 h-full w-full object-cover"
        onLoad={hashes ? handleLoad : undefined}
        fallback={
          <div className="flex h-full w-full items-center justify-center text-neutral-400 dark:text-neutral-600">
            <PhotoIcon className="h-8 w-8" />
          </div>
        }
      />
      {changed && (
        <span
          data-testid={`media-changed-${media.id}`}
          title="The image at this link no longer matches the one the author posted."
          className="absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white"
        >
          Media changed since posting
        </span>
      )}
    </>
  )
}
