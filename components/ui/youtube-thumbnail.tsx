'use client'

import { useEffect, useState } from 'react'
import { IpfsImage } from './ipfs-image'

/**
 * A YouTube video's thumbnail, through the image proxy like every other
 * remote image. maxresdefault is not always present, so a failure falls back
 * to hqdefault; if that fails too, nothing renders over the player's black.
 */
export function YouTubeThumbnail({ videoId, className }: { videoId: string; className?: string }) {
  const [quality, setQuality] = useState<'maxresdefault' | 'hqdefault'>('maxresdefault')

  useEffect(() => {
    setQuality('maxresdefault')
  }, [videoId])

  return (
    <IpfsImage
      src={`https://img.youtube.com/vi/${encodeURIComponent(videoId)}/${quality}.jpg`}
      alt="YouTube video thumbnail"
      className={className}
      onError={() => setQuality('hqdefault')}
    />
  )
}
