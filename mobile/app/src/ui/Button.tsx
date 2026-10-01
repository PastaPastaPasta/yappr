import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentType } from 'react';
import { ActivityIndicator, View, type PressableProps } from 'react-native';

import { cn } from '~/lib-allowlist';

import { ScalePressable } from './ScalePressable';
import { Text } from './Text';
import { hitSlopFor, useColors, type SemanticColors } from './tokens';

/**
 * The web's `buttonVariants` (components/ui/button.tsx), class for class,
 * with UX_SPEC §2.1's touch sizes: `min-h` instead of `h` so labels can wrap
 * at large text sizes, and primary fills darkened in light mode (OQ-2).
 */
export const buttonVariants = cva('flex-row items-center justify-center gap-1.5 rounded-full', {
  variants: {
    variant: {
      primary: 'bg-yappr-600 active:bg-yappr-700 dark:bg-yappr-500 dark:active:bg-yappr-600',
      secondary: 'bg-gray-100 active:bg-gray-200 dark:bg-gray-900 dark:active:bg-gray-800',
      outline:
        'border border-gray-300 bg-transparent active:bg-gray-100 dark:border-gray-700 dark:active:bg-gray-900',
      ghost: 'active:bg-gray-100 dark:active:bg-gray-900',
      destructive: 'bg-red-600 active:bg-red-700',
      link: '',
    },
    size: {
      sm: 'min-h-8 px-3 py-1.5',
      md: 'min-h-10 px-4 py-2',
      lg: 'min-h-12 px-6 py-3',
      block: 'min-h-12 w-full px-6 py-3',
    },
    disabled: { true: 'opacity-50' },
  },
  // The web's shadow is for the default and large primary buttons only. (Not
  // a `shadow-none` override: tailwind-merge reads `shadow-yappr` as a color.)
  compoundVariants: [{ variant: 'primary', size: ['md', 'lg', 'block'], className: 'shadow-yappr' }],
  defaultVariants: { variant: 'primary', size: 'md' },
});

// Each color names its dark value too: it must replace both halves of Text's default tone.
const labelVariants = cva('text-center', {
  variants: {
    variant: {
      primary: 'text-white dark:text-white',
      secondary: 'text-gray-900 dark:text-gray-100',
      outline: 'text-gray-900 dark:text-gray-100',
      ghost: 'text-gray-900 dark:text-gray-100',
      destructive: 'text-white dark:text-white',
      link: 'text-yappr-700 dark:text-yappr-400',
    },
    size: {
      sm: 'text-[13px] leading-4 font-semibold',
      md: 'text-[15px] leading-5 font-semibold',
      lg: 'text-[15px] leading-5 font-semibold',
      block: 'text-[15px] leading-5 font-semibold',
    },
  },
  defaultVariants: { variant: 'primary', size: 'md' },
});

type Variant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;
type Size = NonNullable<VariantProps<typeof buttonVariants>['size']>;

function contentColor(variant: Variant, c: SemanticColors): string {
  if (variant === 'primary' || variant === 'destructive') return c.textInverse;
  if (variant === 'link') return c.link;
  return c.textPrimary;
}

export interface ButtonProps extends Omit<PressableProps, 'children' | 'disabled'> {
  label: string;
  variant?: Variant;
  size?: Size;
  /** A Heroicon (or any icon taking `size` and `color`), drawn 16 before the label. */
  icon?: ComponentType<{ size?: number; color?: string }>;
  loading?: boolean;
  disabled?: boolean;
  className?: string;
}

export function Button({
  label,
  variant = 'primary',
  size = 'md',
  icon: Icon,
  loading = false,
  disabled = false,
  className,
  accessibilityLabel,
  ...props
}: ButtonProps) {
  const c = useColors();
  const color = contentColor(variant, c);
  const inactive = disabled || loading;

  return (
    <ScalePressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      hitSlop={size === 'sm' ? hitSlopFor(32) : undefined}
      wrapperStyle={size === 'block' ? { alignSelf: 'stretch' } : undefined}
      className={cn(buttonVariants({ variant, size, disabled }), className)}
      {...props}
    >
      {({ pressed }) => (
        <>
          {/* Loading keeps the label's width: it goes invisible under the spinner. */}
          <View className="flex-row items-center gap-1.5" style={loading ? { opacity: 0 } : undefined}>
            {Icon ? <Icon size={16} color={color} /> : null}
            <Text
              className={cn(
                labelVariants({ variant, size }),
                variant === 'link' && pressed && 'underline',
              )}
            >
              {label}
            </Text>
          </View>
          {loading ? (
            <View className="absolute inset-0 items-center justify-center">
              <ActivityIndicator size="small" color={color} testID="button-spinner" />
            </View>
          ) : null}
        </>
      )}
    </ScalePressable>
  );
}
