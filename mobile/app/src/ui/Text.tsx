import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { cn } from '~/lib-allowlist';

import { tones, typeScale, type Tone, type TypeToken } from './tokens';

export interface TextProps extends RNTextProps {
  /** A type token (UX_SPEC §1.6). */
  variant?: TypeToken;
  /** Text color token. */
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
export function Text({ variant = 'body', tone = 'primary', tabular, className, style, ...props }: TextProps) {
  return (
    <RNText
      className={cn(typeScale[variant], tones[tone], className)}
      style={tabular ? [{ fontVariant: ['tabular-nums'] }, style] : style}
      {...props}
    />
  );
}
