'use client'

import { useState } from 'react'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  BuildingStorefrontIcon
} from '@heroicons/react/24/outline'

interface ImageGalleryProps {
  images: string[]
  alt: string
}

export function ImageGallery({ images, alt }: ImageGalleryProps) {
  const [currentIndex, setCurrentIndex] = useState(0)

  const handlePrevious = () => {
    setCurrentIndex(i => (i - 1 + images.length) % images.length)
  }

  const handleNext = () => {
    setCurrentIndex(i => (i + 1) % images.length)
  }

  if (images.length === 0) {
    return (
      <div className="relative aspect-square bg-surface-100 dark:bg-surface-800">
        <div className="w-full h-full flex items-center justify-center">
          <BuildingStorefrontIcon className="h-24 w-24 text-gray-300" />
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* Main Image */}
      <div className="relative aspect-square bg-surface-100 dark:bg-surface-800">
        <img
          src={images[currentIndex]}
          alt={alt}
          className="w-full h-full object-contain"
        />

        {images.length > 1 && (
          <>
            <button
              onClick={handlePrevious}
              className="absolute left-2 top-1/2 -translate-y-1/2 p-2 bg-white/80 dark:bg-black/50 rounded-full hover:bg-white dark:hover:bg-black/70 transition-colors"
            >
              <ChevronLeftIcon className="h-5 w-5" />
            </button>
            <button
              onClick={handleNext}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-2 bg-white/80 dark:bg-black/50 rounded-full hover:bg-white dark:hover:bg-black/70 transition-colors"
            >
              <ChevronRightIcon className="h-5 w-5" />
            </button>
          </>
        )}
      </div>

      {/* Thumbnail Strip */}
      {images.length > 1 && (
        <div className="flex gap-2 p-2 overflow-x-auto">
          {images.map((url, i) => (
            <button
              key={i}
              onClick={() => setCurrentIndex(i)}
              className={`flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 transition-colors ${
                i === currentIndex
                  ? 'border-yappr-500'
                  : 'border-transparent hover:border-surface-200 dark:hover:border-gray-600'
              }`}
            >
              <img
                src={url}
                alt={`${alt} ${i + 1}`}
                className="w-full h-full object-cover"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
