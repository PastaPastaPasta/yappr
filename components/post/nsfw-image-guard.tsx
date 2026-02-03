'use client'

import { useState } from 'react'
import Image from 'next/image'
import { EyeOff, Eye } from 'lucide-react'
import { useNsfwDetection } from '@/hooks/use-nsfw-detection'

interface NsfwImageGuardProps {
  src: string
  alt: string
  fill?: boolean
  className?: string
}

export function NsfwImageGuard({ src, alt, fill, className }: NsfwImageGuardProps) {
  const { isNsfw } = useNsfwDetection(src)
  const [revealed, setRevealed] = useState(false)

  const showBlur = isNsfw && !revealed

  return (
    <div className="relative w-full h-full">
      <Image
        src={src}
        alt={alt}
        fill={fill}
        className={`${className ?? ''} transition-all duration-300 ${showBlur ? 'blur-[28px] scale-110' : ''}`}
      />

      {showBlur && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-10">
          <div className="text-center text-white px-4">
            <EyeOff className="w-8 h-8 mx-auto mb-2 opacity-80" />
            <p className="font-semibold text-sm">Sensitive content</p>
            <p className="text-xs opacity-70 mt-1 mb-3">
              This image may contain sensitive content
            </p>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setRevealed(true)
              }}
              className="px-4 py-1.5 text-xs font-medium rounded-full bg-white/20 hover:bg-white/30 transition-colors"
            >
              Show
            </button>
          </div>
        </div>
      )}

      {isNsfw && revealed && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setRevealed(false)
          }}
          className="absolute top-2 right-2 z-10 flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-full bg-black/60 hover:bg-black/80 text-white transition-colors"
        >
          <Eye className="w-3 h-3" />
          Hide
        </button>
      )}
    </div>
  )
}
