import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { cn } from '~/lib-allowlist';

import { remeasureProps, useFontScaleChanges } from './font-scale';
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
 * Text already on screen when the system font scale changes while the app is
 * open kept the boxes it was measured with at the old scale while its glyphs
 * took the new one (clipped at 200 %, floating at 100 %); text mounted after
 * the change measured right. So on each change it mounts anew. On Android
 * (D-rc5a-001) it also takes a new text-size cache key (`remeasureProps`), so
 * React Native measures it afresh rather than handing back a size cached
 * during the change. On iOS (QA rc16 I-01: message bubbles clipped after a
 * live change to a larger Dynamic Type size) React Native re-measures the
 * text on screen at the new size, but React's own copy of the shadow tree
 * keeps the old measurements, and React's next render (a list placing its
 * rows, say) commits them again while the glyphs stay at the new size. Text
 * mounted anew has no old measurement to bring back.
 */
export function Text({ variant = 'body', tone = 'primary', tabular, className, style, ...props }: TextProps) {
  const fontScaleChanges = useFontScaleChanges();
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
