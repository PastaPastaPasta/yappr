'use client'

import {
  CheckCircleIcon,
  ClockIcon,
  TruckIcon,
  XCircleIcon
} from '@heroicons/react/24/outline'
import { orderStatusService } from '@/lib/services/order-status-service'
import type { OrderStatus } from '@/lib/types'

interface OrderStatusBadgeProps {
  status?: OrderStatus
  showLabel?: boolean
}

export function OrderStatusBadge({ status, showLabel = true }: OrderStatusBadgeProps) {
  const getStatusIcon = () => {
    switch (status) {
      case 'delivered':
        return <CheckCircleIcon className="h-5 w-5 text-green-500" />
      case 'shipped':
        return <TruckIcon className="h-5 w-5 text-purple-500" />
      case 'cancelled':
      case 'refunded':
        return <XCircleIcon className="h-5 w-5 text-red-500" />
      default:
        return <ClockIcon className="h-5 w-5 text-yellow-500" />
    }
  }

  const label = status ? orderStatusService.getStatusLabel(status) : 'Pending'
  const colorClass = orderStatusService.getStatusColor(status || 'pending')

  return (
    <div className="flex items-center gap-2">
      {getStatusIcon()}
      {showLabel && (
        <span className={`text-sm font-medium ${colorClass}`}>
          {label}
        </span>
      )}
    </div>
  )
}
