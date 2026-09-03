'use client'

import { motion } from 'framer-motion'
import {
  DocumentTextIcon,
  ArrowPathIcon
} from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { formatNumber } from '@/lib/utils'

interface PlatformStatsProps {
  totalPosts: number
  loading: boolean
  error: string | null
  onRetry?: () => void
}

export function PlatformStats({
  totalPosts,
  loading,
  error,
  onRetry
}: PlatformStatsProps) {
  if (error) {
    return (
      <section className="py-8 border-y border-gray-200 dark:border-gray-800">
        <div className="text-center py-8">
          <p className="text-gray-500 dark:text-gray-400 mb-4">{error}</p>
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <ArrowPathIcon className="h-4 w-4 mr-2" />
              Retry
            </Button>
          )}
        </div>
      </section>
    )
  }

  return (
    <section className="py-8 border-y border-gray-200 dark:border-gray-800">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center"
      >
        <DocumentTextIcon className="h-8 w-8 text-yappr-500 mx-auto mb-2" />
        {loading ? (
          <div className="h-9 w-20 bg-gray-200 dark:bg-gray-800 rounded mx-auto mb-1 animate-pulse" />
        ) : (
          <div className="text-3xl font-bold">{formatNumber(totalPosts)}</div>
        )}
        <div className="text-sm text-gray-500">Total Posts</div>
      </motion.div>
    </section>
  )
}
