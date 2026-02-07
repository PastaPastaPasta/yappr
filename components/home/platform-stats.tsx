'use client'

import { motion } from 'framer-motion'
import {
  DocumentTextIcon,
  UserGroupIcon,
  ArrowPathIcon
} from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { formatNumber } from '@/lib/utils'

interface PlatformStatsProps {
  totalPosts: number
  totalUsers: number
  loading: boolean
  error: string | null
  onRetry?: () => void
}

export function PlatformStats({
  totalPosts,
  totalUsers,
  loading,
  error,
  onRetry
}: PlatformStatsProps) {
  const stats = [
    {
      label: 'Total Posts',
      value: totalPosts,
      icon: DocumentTextIcon,
      color: 'text-yappr-500'
    },
    {
      label: 'Active Users',
      value: totalUsers,
      icon: UserGroupIcon,
      color: 'text-accent-teal'
    },
  ]

  if (error) {
    return (
      <section className="py-8 border-y border-surface-200 dark:border-neutral-750">
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
    <section className="py-8 border-y border-surface-200 dark:border-neutral-750">
      <div className="grid grid-cols-2 gap-8">
        {stats.map((stat, index) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.1 }}
            className="text-center"
          >
            <stat.icon className={`h-8 w-8 ${stat.color} mx-auto mb-2`} />
            {loading ? (
              <div className="h-9 w-20 bg-surface-200 dark:bg-surface-800 rounded mx-auto mb-1 animate-pulse" />
            ) : (
              <div className="text-3xl font-bold text-gray-900 dark:text-gray-100">{formatNumber(stat.value)}</div>
            )}
            <div className="text-sm text-gray-500 dark:text-gray-400">{stat.label}</div>
          </motion.div>
        ))}
      </div>
    </section>
  )
}
