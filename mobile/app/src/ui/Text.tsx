import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { cn } from '~/lib-allowlist';

import { remeasureProps, useAndroidFontScaleChanges } from './font-scale';
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
 * On Android, text already on screen when the system font scale changes
 * while the app is open kept the boxes it was measured with at the old scale
 * while its glyphs took the new one (clipped at 200 %, floating at 100 %;
 * D-rc5a-001); text mounted after the change measured right. So on each
 * change it mounts anew, under a new text-size cache key (`remeasureProps`),
 * so React Native measures it afresh rather than handing back a size cached
 * during the change.
 */
export function Text({ variant = 'body', tone = 'primary', tabular, className, style, ...props }: TextProps) {
  const fontScaleChanges = useAndroidFontScaleChanges();
  return (
    <RNText
      key={fontScaleChanges}
      className={cn(typeScale[variant], tones[tone], className)}
      style={tabular ? [{ fontVariant: ['tabular-nums'] }, style] : style}
      {...props}
      {...remeasureProps(fontScaleChanges)}
    />
  );
}
