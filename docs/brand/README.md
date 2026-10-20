# Brand assets

The live brand set is the folder `public/brand/`. Everything else (favicons, web
app icons, the link-preview image, the iOS and Android icons, the splash, the
mobile app's SVG module) is built from it by `scripts/brand-assets.mjs`.

The installed set is named by `style` in `public/brand/brand.json`. All the
candidate sets are in `candidates/<style>/`, each with a README explaining it.

## Swap to another set

```bash
npm run brand -- --use dash-gradient   # any folder name under docs/brand/candidates/
```

This replaces `public/brand/` with the candidate's files and regenerates every
derived asset. Commit `public/brand/` and the regenerated files it lists. No code
changes: the web components (`components/brand/brand.tsx`) and the mobile ones
(`mobile/app/src/ui/brand/Brand.tsx`) read whatever set is installed, and the
mobile app's icon background comes from `public/brand/brand.json`.

After editing SVGs in `public/brand/` directly, run `npm run brand` (or
`npm run icons` in `mobile/app`, which runs the same script);
`scripts/brand-set.test.mjs` fails until you do. Regenerate on macOS: the
DEV/BETA badges and the link-preview tagline are set in Helvetica Neue, so
other systems draw slightly different PNGs.

## Revert entirely

Revert the brand PR's merge commit. That restores the text logo, the fox icons
and the "Powered by Dash Evolution" image.

The "Powered by Dash" credit is not part of a set: it is plain text styled in
`PoweredByDash` (`components/brand/brand.tsx` on web,
`mobile/app/src/ui/brand/Brand.tsx` on mobile), so swapping a style never
touches it.

## A set's files

Every set has the same files, so any set can be installed:

| File | Used for |
| --- | --- |
| `mark.svg`, `mark-dark.svg` | The icon mark on light and dark backgrounds (64×64 viewBox) |
| `mark-mono.svg` | One-color silhouette (iOS tinted and Android themed icons) |
| `wordmark.svg`, `wordmark-dark.svg` | Lowercase "yappr" (height 64) |
| `lockup.svg`, `lockup-dark.svg` | Mark and wordmark side by side (height 64): sidebar, headers |
| `favicon.svg` | The browser tab icon, drawn for 16 and 32 px |
| `app-icon.svg` | The full-bleed 1024 app tile, subject inside the centered 680 px circle |
| `app-icon-foreground.svg` | The tile's subject on transparency, inside a radius-300 circle (Android adaptive icon, splash) |
| `brand.json` | `style`, and `baseline`: where the wordmark's baseline sits in its 64-unit viewBox |

SVGs must not use `<style>`, `<text>`, `<image>` or `class=` (the mobile app
renders them with react-native-svg's `SvgXml`); the script checks this.
