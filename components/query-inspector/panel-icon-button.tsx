'use client'

import type { ReactNode } from 'react'

/** Round icon button used across the inspector panel chrome. */
export function PanelIconButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className="p-2 rounded-full text-gray-500 hover:bg-gray-100 dark:hover:bg-neutral-900 transition-colors"
    >
      {children}
    </button>
  )
}
