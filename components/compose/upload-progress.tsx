'use client'

import { motion } from 'framer-motion'

interface UploadProgressProps {
  /** Progress percentage (0-100) */
  progress: number
  /** Optional status message */
  message?: string
}

/**
 * Upload progress overlay component.
 * Shows a circular progress indicator with percentage.
 */
export function UploadProgress({ progress, message }: UploadProgressProps) {
  const radius = 40
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - progress / 100)

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 flex flex-col items-center justify-center bg-black/50 backdrop-blur-sm rounded-xl"
    >
      <div className="relative w-24 h-24">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
          {/* Background circle */}
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke="rgba(255,255,255,0.2)"
            strokeWidth="6"
          />
          {/* Progress circle */}
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke="white"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className="transition-all duration-300 ease-out"
          />
        </svg>
        {/* Percentage text */}
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-white text-lg font-semibold tabular-nums">
            {Math.round(progress)}%
          </span>
        </div>
      </div>
      {message && (
        <p className="mt-3 text-white text-sm font-medium">{message}</p>
      )}
    </motion.div>
  )
}
