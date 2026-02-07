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
      color: 'text-yappr-600 dark:text-yappr-400'
    },
  ]

  if (error) {
    return (
      <section className="py-8 border-y border-zinc-200/60 dark:border-zinc-800/40">
        <div className="text-center py-8">
          <p className="text-zinc-500 dark:text-zinc-400 mb-4 text-sm">{error}</p>
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
    <section className="py-10 border-y border-zinc-200/60 dark:border-zinc-800/40">
      <div className="grid grid-cols-2 gap-8">
        {stats.map((stat, index) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.1 }}
            className="text-center"
          >
            <div className="w-12 h-12 rounded-2xl bg-yappr-500/10 flex items-center justify-center mx-auto mb-3">
              <stat.icon className={`h-6 w-6 ${stat.color}`} />
            </div>
            {loading ? (
              <div className="h-9 w-20 bg-zinc-200 dark:bg-zinc-800 rounded-lg mx-auto mb-1.5 animate-pulse" />
            ) : (
              <div className="text-3xl font-bold tracking-tight">{formatNumber(stat.value)}</div>
            )}
            <div className="text-sm text-zinc-500 dark:text-zinc-400">{stat.label}</div>
          </motion.div>
        ))}
      </div>
    </section>
  )
}
