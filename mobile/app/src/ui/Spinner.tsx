import { ActivityIndicator } from 'react-native';

import { useColors } from './tokens';

/** Web sizes xs / sm map to the native small indicator, md / lg to large (UX_SPEC §2.22). */
const SIZES = { xs: 'small', sm: 'small', md: 'large', lg: 'large' } as const;

export interface SpinnerProps {
  size?: keyof typeof SIZES;
  /** Defaults to `accent`; buttons pass their label color. */
  color?: string;
  testID?: string;
}

/** components/ui/spinner.tsx as the native indicator, in `yappr` (not purple, ADR E3). */
export function Spinner({ size = 'md', color, testID }: SpinnerProps) {
  const c = useColors();
  return (
    <ActivityIndicator
      size={SIZES[size]}
      color={color ?? c.accent}
      accessibilityLabel="Loading"
      testID={testID}
    />
  );
}
