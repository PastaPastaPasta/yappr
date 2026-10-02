import { cva, type VariantProps } from 'class-variance-authority';
import { View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

import { cn } from '~/lib-allowlist';

import { useRipple } from './ripple';
import { ScalePressable } from './ScalePressable';
import { Spinner } from './Spinner';
import { Text } from './Text';
import { hitSlopFor, typeScale, useColors, type IconComponent, type SemanticColors } from './tokens';

/**
 * The web's `buttonVariants` (components/ui/button.tsx), class for class,
 * with UX_SPEC §2.1's touch sizes: `min-h` instead of `h` so labels can wrap
 * at large text sizes, and primary fills darkened in light mode (OQ-2).
 * Android clips to the pill so the ripple (src/ui/ripple.ts) keeps its shape;
 * not iOS, where clipping would also cut off the shadow.
 */
const buttonVariants = cva('flex-row items-center justify-center gap-1.5 rounded-full android:overflow-hidden', {
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
      sm: typeScale.buttonSm,
      md: typeScale.button,
      lg: typeScale.button,
      block: typeScale.button,
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
  icon?: IconComponent;
  loading?: boolean;
  disabled?: boolean;
  /** Styles the pressable fill: color, padding, border. */
  className?: string;
  /**
   * Layout in the parent (`flex: 1`, `alignSelf`): the button scales inside
   * a wrapper, so layout classes in `className` don't reach the parent.
   */
  layoutStyle?: StyleProp<ViewStyle>;
}

export function Button({
  label,
  variant = 'primary',
  size = 'md',
  icon: Icon,
  loading = false,
  disabled = false,
  className,
  layoutStyle,
  accessibilityLabel,
  ...props
}: ButtonProps) {
  const c = useColors();
  const color = contentColor(variant, c);
  const inactive = disabled || loading;
  const ripple = useRipple(variant === 'primary' || variant === 'destructive' ? 'fill' : 'surface');

  return (
    <ScalePressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      android_ripple={variant === 'link' ? undefined : ripple}
      hitSlop={size === 'sm' ? hitSlopFor(32) : size === 'md' ? hitSlopFor(40) : undefined}
      wrapperStyle={[size === 'block' ? { alignSelf: 'stretch' } : null, layoutStyle]}
      className={cn(buttonVariants({ variant, size, disabled }), className)}
      {...props}
    >
      {({ pressed }) => (
        <>
          {/* Loading keeps the label's width: it goes invisible under the spinner. */}
          <View className="flex-row items-center gap-1.5" style={loading ? { opacity: 0 } : undefined}>
            {Icon ? <Icon size={16} color={color} /> : null}
            <Text
              className={cn(labelVariants({ variant, size }), variant === 'link' && pressed && 'underline')}
            >
              {label}
            </Text>
          </View>
          {loading ? (
            <View className="absolute inset-0 items-center justify-center">
              <Spinner size="sm" color={color} testID="button-spinner" />
            </View>
          ) : null}
        </>
      )}
    </ScalePressable>
  );
}
