'use client'

import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cn } from '@/lib/utils'

interface SettingsSwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
}

/**
 * A styled switch component for settings pages.
 * Consistent with the app's design system.
 */
export function SettingsSwitch({
  checked,
  onCheckedChange,
  disabled,
  className,
}: SettingsSwitchProps) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        'w-11 h-6 rounded-full relative transition-colors',
        checked ? 'bg-yappr-500' : 'bg-gray-200 dark:bg-gray-800',
        disabled && 'opacity-50 cursor-not-allowed',
        className
      )}
    >
      <SwitchPrimitive.Thumb className="block w-5 h-5 bg-white rounded-full transition-transform data-[state=checked]:translate-x-5 translate-x-0.5" />
    </SwitchPrimitive.Root>
  )
}
