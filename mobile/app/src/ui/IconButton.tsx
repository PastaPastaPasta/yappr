import type { ComponentType } from 'react';
import type { PressableProps } from 'react-native';

import { cn } from '~/lib-allowlist';

import { ScalePressable } from './ScalePressable';
import { hitSlopFor, useColors } from './tokens';

type IconComponent = ComponentType<{ size?: number; color?: string }>;

const VARIANTS = {
  default: 'active:bg-gray-100 dark:active:bg-gray-900',
  primary: 'active:bg-yappr-50 dark:active:bg-yappr-950',
  danger: 'active:bg-red-50 dark:active:bg-red-950',
} as const;

export interface IconButtonProps extends Omit<PressableProps, 'children'> {
  icon: IconComponent;
  /** Required: an icon-only control has no visible label (UX_SPEC §5.13). */
  accessibilityLabel: string;
  variant?: keyof typeof VARIANTS;
  /** Icon tint; defaults to the variant's (secondary, accent or destructive). */
  color?: string;
  iconSize?: number;
  className?: string;
}

/**
 * The web's `IconButton`: a 36 pt circle (`h-9 w-9`) with a 20 pt icon,
 * padded to a 48 pt touch target.
 */
export function IconButton({
  icon: Icon,
  variant = 'default',
  color,
  iconSize = 20,
  className,
  disabled,
  ...props
}: IconButtonProps) {
  const c = useColors();
  const tint =
    color ?? (variant === 'primary' ? c.link : variant === 'danger' ? c.destructive : c.textSecondary);

  return (
    <ScalePressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      hitSlop={hitSlopFor(36)}
      className={cn(
        'h-9 w-9 items-center justify-center rounded-full',
        VARIANTS[variant],
        disabled && 'opacity-50',
        className,
      )}
      {...props}
    >
      <Icon size={iconSize} color={tint} />
    </ScalePressable>
  );
}
