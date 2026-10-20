import { SvgXml } from 'react-native-svg';

import { useIsDark } from '~/ui/tokens';

import { brandRatio, brandSvgs } from './svgs';

/**
 * The brand set from the web's public/brand/, generated into ./svgs.ts by
 * scripts/brand-assets.mjs (see docs/brand/README.md). Each asset has a light-
 * and a dark-background version, picked by the effective theme.
 */
function BrandSvg({ light, dark, width, height, label, role }: {
  light: string;
  dark: string;
  width: number;
  height: number;
  label?: string;
  role?: 'image' | 'header';
}) {
  return (
    <SvgXml
      xml={useIsDark() ? dark : light}
      width={width}
      height={height}
      accessible={label !== undefined}
      accessibilityRole={label === undefined ? undefined : role}
      accessibilityLabel={label}
    />
  );
}

/** The icon mark, square. `decorative` hides it from screen readers. */
export function BrandMark({ size = 32, decorative = false }: { size?: number; decorative?: boolean }) {
  return (
    <BrandSvg
      light={brandSvgs.mark}
      dark={brandSvgs.markDark}
      width={size}
      height={size}
      label={decorative ? undefined : 'Yappr'}
      role="image"
    />
  );
}

/** Mark and wordmark side by side, `height` tall. */
export function Lockup({ height = 32, header = false }: { height?: number; header?: boolean }) {
  return (
    <BrandSvg
      light={brandSvgs.lockup}
      dark={brandSvgs.lockupDark}
      width={Math.round(height * brandRatio.lockup)}
      height={height}
      label="Yappr"
      role={header ? 'header' : 'image'}
    />
  );
}

/** The "Powered by Dash" credit. */
export function PoweredByDash({ height = 24 }: { height?: number }) {
  return (
    <BrandSvg
      light={brandSvgs.poweredBy}
      dark={brandSvgs.poweredByDark}
      width={Math.round(height * brandRatio.poweredBy)}
      height={height}
      label="Powered by Dash"
      role="image"
    />
  );
}
