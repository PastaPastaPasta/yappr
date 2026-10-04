import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { cn } from '~/lib-allowlist';

import { useAndroidFontScale } from './font-scale';
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
 *
 * On Android it mounts anew when the system font scale changes while the app
 * is open: text already on screen kept the boxes it was measured with at the
 * old scale while its glyphs took the new one (clipped at 200 %, floating at
 * 100 %; D-rc5a-001), and text mounted after the change measures right.
 */
export function Text({ variant = 'body', tone = 'primary', tabular, className, style, ...props }: TextProps) {
  const fontScale = useAndroidFontScale();
  return (
    <RNText
      key={fontScale}
      className={cn(typeScale[variant], tones[tone], className)}
      style={tabular ? [{ fontVariant: ['tabular-nums'] }, style] : style}
      {...props}
    />
  );
}
