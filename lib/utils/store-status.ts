import type { StoreStatus } from '@/lib/types'

interface StoreStatusConfig {
  label: string
  description: string
  badgeClasses: string
}

const STORE_STATUS_CONFIG: Record<StoreStatus, StoreStatusConfig> = {
  active: {
    label: 'Active',
    description: 'Your store is visible to buyers',
    badgeClasses: 'bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400'
  },
  paused: {
    label: 'Paused',
    description: 'Your store is temporarily hidden',
    badgeClasses: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-400'
  },
  closed: {
    label: 'Closed',
    description: 'Your store is closed',
    badgeClasses: 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400'
  }
}

export function getStoreStatusLabel(status: StoreStatus): string {
  return STORE_STATUS_CONFIG[status].label
}

export function getStoreStatusDescription(status: StoreStatus): string {
  return STORE_STATUS_CONFIG[status].description
}

export function getStoreStatusBadgeClasses(status: StoreStatus): string {
  return STORE_STATUS_CONFIG[status].badgeClasses
}
