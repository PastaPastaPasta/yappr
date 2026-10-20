#!/usr/bin/env node
/**
 * Builds every brand raster and generated file from the SVG set in public/brand/.
 * The output is committed; rerun this after changing the set:
 *
 *   npm run brand                       regenerate from public/brand/
 *   npm run brand -- --use <style>      install docs/brand/candidates/<style>/ first, then regenerate
 *
 * public/brand/ holds one set in the file layout of docs/brand/README.md (mark, wordmark, lockup,
 * favicon, app icon, powered-by). This writes:
 *   public/brand/brand.json                      the set's name, aspect ratios and icon background
 *   public/favicon.ico                           16, 32 and 48 px from favicon.svg
 *   public/icon-192.png, icon-512.png            rounded tiles for the web manifest
 *   public/icon-maskable-512.png                 full bleed, for Android's maskable icon
 *   public/apple-touch-icon.png                  180 px, full bleed (iOS rounds it)
 *   public/og-image.jpg                          the 1200x630 link preview
 *   mobile/app/src/ui/brand/svgs.ts              the SVG sources for react-native-svg
 *   mobile/app/assets/images/icons/<variant>/*   iOS light/dark/tinted and Android adaptive icons
 *   mobile/app/assets/images/splash-icon.png     the splash image
 *
 * devnet gets an amber "DEV" badge and testnet a yappr-blue "BETA" one: a corner ribbon on iOS,
 * a pill under the mark on Android, where the launcher's mask would clip a corner.
 *
 * sharp is not a dependency of either app. The script installs it into a per-user cache folder
 * (~/.cache/yappr-icon-tools-<version>) on first run.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FILES, problems, ratioOf } from './brand-set.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = path.join(ROOT, 'public/brand');
const CANDIDATES = path.join(ROOT, 'docs/brand/candidates');
const PUBLIC = path.join(ROOT, 'public');
const MOBILE_IMAGES = path.join(ROOT, 'mobile/app/assets/images');
const MOBILE_SVGS = path.join(ROOT, 'mobile/app/src/ui/brand/svgs.ts');
const SHARP_VERSION = '0.34.5';


const SIZE = 1024;
/** The adaptive icon's safe zone (a 66 dp circle on a 108 dp layer) and the sets' subject circle. */
const SAFE_RADIUS = (SIZE * 33) / 108;
const SUBJECT_RADIUS = 300;

/** Badge colors: Tailwind amber-500 and the web's yappr-500, as in mobile/app/src/ui/tokens.ts. */
const BADGES = {
  devnet: { label: 'DEV', fill: '#f59e0b', text: '#162553' },
  testnet: { label: 'BETA', fill: '#0ea5e9', text: '#ffffff' },
  production: null,
};

function loadSharp() {
  const dir = path.join(os.homedir(), '.cache', `yappr-icon-tools-${SHARP_VERSION}`);
  const requireFromDir = createRequire(path.join(dir, 'package.json'));
  // A half-finished install has the folder but no package.json; npm install completes it.
  if (!fs.existsSync(path.join(dir, 'node_modules/sharp/package.json'))) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', dir, `sharp@${SHARP_VERSION}`], {
      stdio: 'inherit',
    });
  }
  return requireFromDir('sharp');
}

const sharp = loadSharp();

const read = (file) => fs.readFileSync(path.join(BRAND, file), 'utf8');

/** The SVG with its root size set, so librsvg draws it at exactly that many pixels. */
function sized(svg, width, height) {
  const open = /<svg\b[^>]*>/.exec(svg)[0];
  const resized = open
    .replace(/\s(width|height)="[^"]*"/g, '')
    .replace('<svg', `<svg width="${width}" height="${height}"`);
  return Buffer.from(svg.replace(open, resized));
}

const render = (svg, width, height = width) => sharp(sized(svg, width, height)).png().toBuffer();

const canvas = (width, height, background = { r: 0, g: 0, b: 0, alpha: 0 }) =>
  sharp({ create: { width, height, channels: 4, background } });

async function writePng(image, file, { flatten } = {}) {
  let pipeline = sharp(await image.png().toBuffer());
  if (flatten) pipeline = pipeline.flatten({ background: flatten });
  await pipeline.png({ compressionLevel: 9, palette: true, quality: 100, effort: 10 }).toFile(file);
  console.log(`  ${path.relative(ROOT, file)}`);
}

/** Copies a candidate set over public/brand/, so a swap is one command and one folder in git. */
function install(style) {
  const known = fs.readdirSync(CANDIDATES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  if (!known.includes(style)) throw new Error(`No candidate "${style}". Known: ${known.join(', ')}`);
  const from = path.join(CANDIDATES, style);
  const found = problems(from);
  if (found.length) throw new Error(`${style} can't be installed: ${found.join('; ')}`);
  fs.rmSync(BRAND, { recursive: true, force: true });
  fs.mkdirSync(BRAND, { recursive: true });
  for (const file of [...FILES, 'brand.json']) fs.copyFileSync(path.join(from, file), path.join(BRAND, file));
  console.log(`installed ${style} into public/brand/`);
}

function check() {
  const found = problems(BRAND);
  if (found.length) throw new Error(`public/brand/: ${found.join('; ')}`);
}

/** The authored fields (style, baseline) plus the ones measured from the files. */
async function writeManifest() {
  const authored = JSON.parse(read('brand.json'));
  const ratio = (file) => ratioOf(read(file));
  // The tile's corner pixel is its background, which the splash and adaptive icon blend with.
  const { data } = await sharp(await render(read('app-icon.svg'), 64)).raw().toBuffer({ resolveWithObject: true });
  if (data[3] !== 255) throw new Error('app-icon.svg must be opaque (its corner pixel is the icon background)');
  const iconBackground = `#${[data[0], data[1], data[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const manifest = {
    style: authored.style,
    // Where the wordmark's baseline sits, in its 64-unit-high viewBox (for inline use in text).
    baseline: authored.baseline,
    iconBackground,
    ratio: { wordmark: ratio('wordmark.svg'), lockup: ratio('lockup.svg'), poweredBy: ratio('powered-by.svg') },
  };
  fs.writeFileSync(path.join(BRAND, 'brand.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`  public/brand/brand.json (${manifest.style}, icon background ${iconBackground})`);
  return manifest;
}

/** An ICO holding PNG images (supported everywhere since Windows Vista). */
async function writeIco(file, sizes) {
  const images = await Promise.all(sizes.map((size) => render(read('favicon.svg'), size)));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((png, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(sizes[i] % 256, entry);
    header.writeUInt8(sizes[i] % 256, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  fs.writeFileSync(file, Buffer.concat([header, ...images]));
  console.log(`  ${path.relative(ROOT, file)}`);
}

/** The app tile with rounded corners, for places that show the icon as-is. */
async function roundedTile(size) {
  const radius = Math.round(size * 0.225);
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="#fff"/></svg>`,
  );
  return sharp(await render(read('app-icon.svg'), size)).composite([{ input: mask, blend: 'dest-in' }]);
}

async function web(manifest) {
  console.log('web:');
  await writeIco(path.join(PUBLIC, 'favicon.ico'), [16, 32, 48]);
  for (const size of [192, 512]) await writePng(await roundedTile(size), path.join(PUBLIC, `icon-${size}.png`));
  await writePng(sharp(await render(read('app-icon.svg'), 512)), path.join(PUBLIC, 'icon-maskable-512.png'));
  await writePng(sharp(await render(read('app-icon.svg'), 180)), path.join(PUBLIC, 'apple-touch-icon.png'));

  // The link preview: the tile, the lockup's wordmark and the tagline on the brand's pale blue.
  const wordmarkHeight = 150;
  const wordmarkWidth = Math.round(wordmarkHeight * manifest.ratio.wordmark);
  const card = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <defs><radialGradient id="g" cx="0.8" cy="0.2" r="0.6"><stop offset="0" stop-color="#bae6fd"/><stop offset="1" stop-color="#f0f9ff"/></radialGradient></defs>
  <rect width="1200" height="630" fill="url(#g)"/>
  <g font-family="Helvetica Neue, Helvetica, Arial, sans-serif">
    <text x="510" y="390" font-size="44" font-weight="700" fill="#0c4a6e">Social media you own.</text>
    <text x="510" y="442" font-size="26" fill="#075985">Your identity and posts live on Dash Platform.</text>
  </g>
</svg>`);
  const tile = await (await roundedTile(300)).png().toBuffer();
  await sharp(card)
    .composite([
      { input: tile, left: 136, top: 165 },
      { input: await render(read('wordmark.svg'), wordmarkWidth, wordmarkHeight), left: 506, top: 170 },
    ])
    .flatten({ background: '#f0f9ff' })
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(path.join(PUBLIC, 'og-image.jpg'));
  console.log('  public/og-image.jpg');
}

function mobileSvgs(manifest) {
  const entry = (name, file) => `  ${name}: ${JSON.stringify(read(file).trim())},`;
  const source = `// Generated by scripts/brand-assets.mjs from public/brand/ (${manifest.style}). Do not edit.

export const brandSvgs = {
${entry('mark', 'mark.svg')}
${entry('markDark', 'mark-dark.svg')}
${entry('lockup', 'lockup.svg')}
${entry('lockupDark', 'lockup-dark.svg')}
${entry('poweredBy', 'powered-by.svg')}
${entry('poweredByDark', 'powered-by-dark.svg')}
} as const;

/** Width over height of each wide asset (the marks are square). */
export const brandRatio = ${JSON.stringify({ lockup: manifest.ratio.lockup, poweredBy: manifest.ratio.poweredBy })} as const;
`;
  fs.mkdirSync(path.dirname(MOBILE_SVGS), { recursive: true });
  fs.writeFileSync(MOBILE_SVGS, source);
  console.log(`  ${path.relative(ROOT, MOBILE_SVGS)}`);
}

const FONT = `font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-weight="800"`;

/** A ribbon across the top-right corner, clear of the iOS mask's rounded corner. */
function ribbonSvg(badge, { fill = badge.fill, text = badge.text, edge = '#ffffff' } = {}) {
  const c = 205;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
  <g transform="translate(${SIZE - c} ${c}) rotate(45)">
    <rect x="-700" y="-70" width="1400" height="140" fill="${fill}"/>
    <rect x="-700" y="-70" width="1400" height="9" fill="${edge}"/>
    <rect x="-700" y="61" width="1400" height="9" fill="${edge}"/>
    <text x="0" y="34" text-anchor="middle" font-size="96" letter-spacing="8" ${FONT} fill="${text}">${badge.label}</text>
  </g>
</svg>`);
}

const PILL = { cx: SIZE / 2, cy: 745, width: 270, height: 100 };

/**
 * A pill under the mark, inside the adaptive icon's safe zone. With `knockout`, the label is
 * cut out of a white pill (for the monochrome icon, where only alpha counts).
 */
function pillSvg(badge, { knockout = false } = {}) {
  const { cx, cy, width, height } = PILL;
  const x = cx - width / 2;
  const y = cy - height / 2;
  const label = `<text x="${cx}" y="${cy + 26}" text-anchor="middle" font-size="74" letter-spacing="6" ${FONT}`;
  const body = knockout
    ? `<mask id="m"><rect width="${SIZE}" height="${SIZE}" fill="#fff"/>${label} fill="#000">${badge.label}</text></mask>
  <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" fill="#fff" mask="url(#m)"/>`
    : `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" fill="${badge.fill}" stroke="#fff" stroke-width="8"/>
  ${label} fill="${badge.text}">${badge.label}</text>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">${body}</svg>`);
}

/** mark-mono.svg (all #000) recolored to one fill. */
const monoSvg = (fill) => read('mark-mono.svg').replace(/#000000|#000\b|black/gi, fill);

/**
 * A square layer, its subject (drawn inside a centered circle of `from` radius) scaled so that
 * circle has radius `radius` around (SIZE/2, cy). `viewSize` is the source's viewBox side.
 */
async function placed(svg, viewSize, from, radius, cy = SIZE / 2) {
  const side = Math.round((viewSize * radius) / from);
  const left = Math.round(SIZE / 2 - side / 2);
  const top = Math.round(cy - side / 2);
  // sharp only composites layers that fit the canvas, so cut off what falls outside it.
  const crop = { left: Math.max(0, -left), top: Math.max(0, -top) };
  crop.width = Math.min(side - crop.left, SIZE - Math.max(0, left));
  crop.height = Math.min(side - crop.top, SIZE - Math.max(0, top));
  const layer = await sharp(await render(svg, side)).extract(crop).png().toBuffer();
  return canvas(SIZE, SIZE)
    .composite([{ input: layer, left: Math.max(0, left), top: Math.max(0, top) }])
    .png()
    .toBuffer();
}

async function mobile(manifest) {
  const background = manifest.iconBackground;
  const foreground = read('app-icon-foreground.svg');
  // The mono mark fills its 64-unit box; its inscribed circle (r 32) stands in for the subject circle.
  const whiteMark = monoSvg('#ffffff');
  const placedMono = (radius, cy) => placed(whiteMark, 64, 32, radius * 0.92, cy);
  const fullForeground = await render(foreground, SIZE);
  const tinted = await placedMono(SUBJECT_RADIUS);

  for (const [variant, badge] of Object.entries(BADGES)) {
    const dir = path.join(MOBILE_IMAGES, 'icons', variant);
    fs.mkdirSync(dir, { recursive: true });
    console.log(`${variant}:`);
    const ribbon = (opts) => (badge ? [{ input: ribbonSvg(badge, opts) }] : []);

    await writePng(sharp(await render(read('app-icon.svg'), SIZE)).composite(ribbon()), path.join(dir, 'ios-light.png'), {
      flatten: background,
    });
    await writePng(sharp(fullForeground).composite(ribbon()), path.join(dir, 'ios-dark.png'));
    await writePng(
      sharp(tinted).composite(ribbon({ fill: '#e5e5e5', text: '#262626', edge: '#a3a3a3' })),
      path.join(dir, 'ios-tinted.png'),
    );

    // With a badge, the subject shrinks and moves up to leave the pill room inside the safe zone.
    const [radius, cy] = badge ? [235, 455] : [SAFE_RADIUS * 0.93, SIZE / 2];
    const fg = await placed(foreground, SIZE, SUBJECT_RADIUS, radius, cy);
    const monoFg = await placedMono(radius, cy);
    await writePng(
      canvas(SIZE, SIZE).composite([{ input: fg }, ...(badge ? [{ input: pillSvg(badge) }] : [])]),
      path.join(dir, 'android-foreground.png'),
    );
    await writePng(
      canvas(SIZE, SIZE).composite([{ input: monoFg }, ...(badge ? [{ input: pillSvg(badge, { knockout: true }) }] : [])]),
      path.join(dir, 'android-monochrome.png'),
    );
  }

  console.log('splash:');
  await writePng(
    sharp(await placed(foreground, SIZE, SUBJECT_RADIUS, SIZE * 0.48)),
    path.join(MOBILE_IMAGES, 'splash-icon.png'),
  );
}

async function main() {
  const use = process.argv.indexOf('--use');
  if (use !== -1) install(process.argv[use + 1]);
  check();
  const manifest = await writeManifest();
  await web(manifest);
  console.log('mobile:');
  mobileSvgs(manifest);
  await mobile(manifest);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
