import { View, type ViewProps } from 'react-native';

import { cn } from '~/lib-allowlist';

import { Text, type TextProps } from './Text';

type Props = ViewProps & { className?: string };

/** components/ui/card.tsx, class for class. */
export function Card({ className, ...props }: Props) {
  return (
    <View
      className={cn(
        'rounded-xl border border-gray-200 bg-white shadow dark:border-gray-800 dark:bg-gray-950',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: Props) {
  return <View className={cn('gap-1.5 p-6', className)} {...props} />;
}

export function CardTitle({ className, ...props }: TextProps) {
  return (
    <Text
      variant="bodyStrong"
      tone="emphasis"
      accessibilityRole="header"
      className={cn('leading-none tracking-tight', className)}
      {...props}
    />
  );
}

export function CardDescription(props: TextProps) {
  return <Text variant="subhead" tone="secondary" {...props} />;
}

export function CardContent({ className, ...props }: Props) {
  return <View className={cn('p-6 pt-0', className)} {...props} />;
}

export function CardFooter({ className, ...props }: Props) {
  return <View className={cn('flex-row items-center p-6 pt-0', className)} {...props} />;
}
