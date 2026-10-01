import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { cn } from '~/lib-allowlist';

import { tones, typeScale, type Tone, type TypeToken } from './tokens';

/** The scaffold's original presets, each a size and a color. */
const PRESETS = {
  title: 'text-2xl font-bold text-gray-900 dark:text-white',
  muted: 'text-sm text-gray-500 dark:text-gray-400',
  /** On an accent fill (buttons, chips). */
  onBrand: 'text-base font-semibold text-white',
} as const;

export type TextVariant = TypeToken | keyof typeof PRESETS;

export interface TextProps extends RNTextProps {
  /** A type token (UX_SPEC §1.6), or one of the scaffold presets. */
  variant?: TextVariant;
  /** Text color token. Ignored by the presets, which carry their own. */
  tone?: Tone;
  /** Tabular figures, for counters and balances. */
  tabular?: boolean;
  className?: string;
}

/**
 * Text with the web's type scale and colors. Pick the color with `tone`
 * rather than a `text-*` class: a plain class can't override the `dark:`
 * half of a tone.
 */
export function Text({
  variant = 'body',
  tone = 'primary',
  tabular,
  className,
  style,
  ...props
}: TextProps) {
  const base =
    variant in PRESETS
      ? PRESETS[variant as keyof typeof PRESETS]
      : `${typeScale[variant as TypeToken]} ${tones[tone]}`;
  return (
    <RNText
      className={cn(base, className)}
      style={tabular ? [{ fontVariant: ['tabular-nums'] }, style] : style}
      {...props}
    />
  );
}
