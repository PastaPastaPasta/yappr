import { View } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Text as SvgText } from 'react-native-svg';

import { colors } from '~/ui/tokens';

/** "Yappr" is about 2.7 em wide in the system bold face. */
const WIDTH_EM = 2.75;

/**
 * The "Yappr" wordmark: the web's `.text-gradient`, yappr-500 → yappr-600
 * left to right, clipped to bold text (UX_SPEC §1.3).
 */
export function Wordmark({ size = 48 }: { size?: number }) {
  const width = Math.ceil(size * WIDTH_EM);
  const height = Math.ceil(size * 1.25);
  return (
    <View accessible accessibilityRole="header" accessibilityLabel="Yappr" style={{ width, height }}>
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id="yappr-wordmark" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={colors.yappr500} />
            <Stop offset="1" stopColor={colors.yappr600} />
          </LinearGradient>
        </Defs>
        <SvgText
          x={width / 2}
          y={size}
          textAnchor="middle"
          fontSize={size}
          fontWeight="800"
          fill="url(#yappr-wordmark)"
        >
          Yappr
        </SvgText>
      </Svg>
    </View>
  );
}
