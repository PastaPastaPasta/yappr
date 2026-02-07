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
      gradient: 'from-yappr-500 to-yappr-600',
      bgLight: 'bg-yappr-50',
      bgDark: 'dark:bg-yappr-950/30',
    },
    {
      label: 'Active Users',
      value: totalUsers,
      icon: UserGroupIcon,
      gradient: 'from-accent-500 to-accent-600',
      bgLight: 'bg-accent-50',
      bgDark: 'dark:bg-accent-950/30',
    },
  ]

  if (error) {
    return (
      <section className="py-8 border-y border-border">
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
    <section className="py-10 border-y border-border">
      <div className="grid grid-cols-2 gap-6 max-w-lg mx-auto">
        {stats.map((stat, index) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.1, duration: 0.5 }}
            className="text-center"
          >
            <div className={`w-12 h-12 rounded-2xl ${stat.bgLight} ${stat.bgDark} flex items-center justify-center mx-auto mb-3`}>
              <stat.icon className={`h-6 w-6 bg-gradient-to-br ${stat.gradient} bg-clip-text text-yappr-500`} />
            </div>
            {loading ? (
              <div className="h-9 w-20 skeleton mx-auto mb-1.5 rounded-lg" />
            ) : (
              <div className="text-3xl font-display font-bold tracking-tight">{formatNumber(stat.value)}</div>
            )}
            <div className="text-sm text-gray-500 dark:text-gray-400">{stat.label}</div>
          </motion.div>
        ))}
      </div>
    </section>
  )
}
