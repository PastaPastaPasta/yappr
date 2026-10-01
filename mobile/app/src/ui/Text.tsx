import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

const VARIANTS = {
  title: 'text-2xl font-bold text-gray-900 dark:text-white',
  body: 'text-base text-gray-900 dark:text-gray-100',
  muted: 'text-sm text-gray-500',
  /** On a `bg-yappr-500` fill (buttons, chips). */
  onBrand: 'text-base font-semibold text-white',
} as const;

export interface TextProps extends RNTextProps {
  variant?: keyof typeof VARIANTS;
  className?: string;
}

/**
 * Text with the web's type colors. Pick colors with `variant`; `className` is
 * for layout and spacing, since NativeWind resolves conflicting color classes
 * by stylesheet order, not by the order they are written in.
 */
export function Text({ variant = 'body', className, ...props }: TextProps) {
  return <RNText className={`${VARIANTS[variant]} ${className ?? ''}`} {...props} />;
}
