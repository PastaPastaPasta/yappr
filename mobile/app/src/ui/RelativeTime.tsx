import { Text, type TextProps } from './Text';
import { useRelativeTime } from './use-relative-time';

export interface RelativeTimeProps extends Omit<TextProps, 'children'> {
  date: Date;
  /** Text before the time, e.g. "· ". */
  prefix?: string;
}

/**
 * The live compact time as its own leaf, so its ticks (every second for a
 * post under a minute old) re-render this text and not the card around it.
 */
export function RelativeTime({ date, prefix = '', ...props }: RelativeTimeProps) {
  const label = useRelativeTime(date);
  return (
    <Text {...props}>
      {prefix}
      {label}
    </Text>
  );
}
