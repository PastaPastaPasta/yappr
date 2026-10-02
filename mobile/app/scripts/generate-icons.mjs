#!/usr/bin/env node
/**
 * Generates the per-variant app icons and the splash image from the fox
 * (assets/images/icon.png). The output is committed; rerun this only when the
 * source art or the badges change:
 *
 *   node scripts/generate-icons.mjs
 *
 * Writes, for each variant (devnet, testnet, production):
 *   assets/images/icons/<variant>/ios-light.png          opaque, the App Store icon
 *   assets/images/icons/<variant>/ios-dark.png           the fox on transparency (iOS 18+ dark)
 *   assets/images/icons/<variant>/ios-tinted.png         grayscale on transparency (iOS 18+ tinted)
 *   assets/images/icons/<variant>/android-foreground.png adaptive foreground inside the 66/108 safe zone
 *   assets/images/icons/<variant>/android-monochrome.png Android 13 themed icon (alpha only)
 * and assets/images/splash-icon.png (the fox on transparency, shared by every variant).
 *
 * devnet gets an amber "DEV" badge and testnet a yappr-blue "BETA" one: a
 * corner ribbon on iOS, a pill under the fox on Android, where the launcher's
 * mask would clip a corner.
 *
 * sharp is not an app dependency. The script installs it into a cache folder
 * under the OS temp dir on first run.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGES = path.join(APP_DIR, 'assets/images');
const SOURCE = path.join(IMAGES, 'icon.png');
const SHARP_VERSION = '0.34.5';

const SIZE = 1024;
/** Radius of the adaptive icon's safe zone: a 66 dp circle on a 108 dp layer. */
const SAFE_RADIUS = (SIZE * 33) / 108;

// The source art's flat colors. BACKGROUND is also ICON_BACKGROUND in app.config.ts.
const BACKGROUND = [15, 135, 207];
const NAVY = [22, 37, 83];
const ORANGE = [253, 96, 26];
const YELLOW = [253, 214, 15];

/** Badge colors: Tailwind amber-500 and the web's yappr-500, as in src/ui/tokens.ts. */
const BADGES = {
  devnet: { label: 'DEV', fill: '#f59e0b', text: '#162553' },
  testnet: { label: 'BETA', fill: '#0ea5e9', text: '#ffffff' },
  production: null,
};

function loadSharp() {
  const dir = path.join(os.tmpdir(), `yappr-icon-tools-${SHARP_VERSION}`);
  const requireFromDir = createRequire(path.join(dir, 'package.json'));
  if (!fs.existsSync(path.join(dir, 'node_modules/sharp'))) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', dir, `sharp@${SHARP_VERSION}`], {
      stdio: 'inherit',
    });
  }
  return requireFromDir('sharp');
}

const sharp = loadSharp();

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const len = (a) => Math.sqrt(dot(a, a));

/** Where `c` sits on the segment from `a` to `b` (0..1), and how far it is from it. */
function onSegment(c, a, b) {
  const ab = sub(b, a);
  const t = clamp01(dot(sub(c, a), ab) / dot(ab, ab));
  const off = len(sub(c, [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]]));
  return { t, off };
}

/**
 * Lifts the fox off its blue background. Every edge pixel that touches the
 * background is a blend of it with the navy outline or a yellow sound line, so
 * it is un-mixed into that pure color with a partial alpha (no blue fringe).
 * Returns RGBA plus, per pixel, how much of it is "ink" (outline, eye, lines)
 * rather than the orange fill, for the one-color icons.
 */
async function extractFox() {
  const { data, info } = await sharp(SOURCE).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== SIZE || info.height !== SIZE) throw new Error(`${SOURCE} must be ${SIZE}x${SIZE}`);
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const ink = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const p = [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
    let color = p;
    let alpha = 1;
    const edge = [NAVY, YELLOW]
      .map((pure) => ({ pure, ...onSegment(p, BACKGROUND, pure) }))
      .sort((x, y) => x.off - y.off)[0];
    if (edge.off < 28) {
      alpha = edge.t < 0.04 ? 0 : edge.t;
      color = edge.pure;
    }
    rgba.set([color[0], color[1], color[2], Math.round(alpha * 255)], i * 4);
    const fill = onSegment(color, NAVY, ORANGE);
    ink[i] = len(sub(color, YELLOW)) < fill.off ? 1 : 1 - fill.t;
  }
  return { rgba, ink, bounds: contentBounds(rgba) };
}

/** Bounding box and center of the opaque pixels, and the radius of the circle around them. */
function contentBounds(rgba) {
  let [x0, y0, x1, y1] = [SIZE, SIZE, 0, 0];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (rgba[(y * SIZE + x) * 4 + 3] < 128) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  let radius = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (rgba[(y * SIZE + x) * 4 + 3] >= 128) radius = Math.max(radius, Math.hypot(x - cx, y - cy));
    }
  }
  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, cx, cy, radius };
}

/** Maps every fox pixel through `fn(r, g, b, a, ink) => [r, g, b, a]`. */
function recolor(fox, fn) {
  const out = Buffer.alloc(fox.rgba.length);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const o = i * 4;
    out.set(fn(fox.rgba[o], fox.rgba[o + 1], fox.rgba[o + 2], fox.rgba[o + 3], fox.ink[i]), o);
  }
  return out;
}

const raw = (buffer) => sharp(buffer, { raw: { width: SIZE, height: SIZE, channels: 4 } });

/**
 * The fox scaled so its outermost pixel sits `radius` from (cx, cy), as a
 * composite layer for a SIZE canvas.
 */
async function placedFox(buffer, bounds, radius, cx, cy) {
  const scale = radius / bounds.radius;
  const width = Math.round(bounds.width * scale);
  const height = Math.round(bounds.height * scale);
  const input = await raw(buffer)
    .extract({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height })
    .resize(width, height)
    .png()
    .toBuffer();
  return {
    input,
    left: Math.round(cx - (bounds.cx - bounds.left) * scale),
    top: Math.round(cy - (bounds.cy - bounds.top) * scale),
  };
}

const FONT = `font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-weight="800"`;

/**
 * A ribbon across the top-right corner, clear of the fox's snout and of the
 * iOS mask's rounded corner.
 */
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
 * A pill under the fox, inside the adaptive icon's safe zone. With
 * `knockout`, the label is cut out of a white pill (for the monochrome icon,
 * where only alpha counts).
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

const canvas = (background = { r: 0, g: 0, b: 0, alpha: 0 }) =>
  sharp({ create: { width: SIZE, height: SIZE, channels: 4, background } });

async function writePng(image, file, { opaque = false } = {}) {
  let pipeline = sharp(await image.png().toBuffer());
  if (opaque) pipeline = pipeline.flatten({ background: { r: BACKGROUND[0], g: BACKGROUND[1], b: BACKGROUND[2] } });
  await pipeline.png({ compressionLevel: 9, palette: true, quality: 100, effort: 10 }).toFile(file);
  console.log(`  ${path.relative(APP_DIR, file)}`);
}

async function main() {
  const fox = await extractFox();
  // Tinted: the ink white and the fill mid-gray; iOS maps luminance to the tint.
  const tinted = recolor(fox, (r, g, b, a, ink) => {
    const v = Math.round(255 * (ink + (1 - ink) * 0.42));
    return [v, v, v, a];
  });
  // Monochrome: line art (outline, eye, mouth, sound lines); Android uses only the alpha.
  const mono = recolor(fox, (r, g, b, a, ink) => [255, 255, 255, Math.round(a * ink)]);

  for (const [variant, badge] of Object.entries(BADGES)) {
    const dir = path.join(IMAGES, 'icons', variant);
    fs.mkdirSync(dir, { recursive: true });
    console.log(`${variant}:`);
    const ribbon = (opts) => (badge ? [{ input: ribbonSvg(badge, opts) }] : []);

    await writePng(sharp(SOURCE).composite(ribbon()), path.join(dir, 'ios-light.png'), { opaque: true });
    await writePng(raw(fox.rgba).composite(ribbon()), path.join(dir, 'ios-dark.png'));
    await writePng(
      raw(tinted).composite(ribbon({ fill: '#e5e5e5', text: '#262626', edge: '#a3a3a3' })),
      path.join(dir, 'ios-tinted.png'),
    );

    // With a badge, the fox shrinks and moves up to leave the pill room inside the safe zone.
    const [radius, cy] = badge ? [235, 455] : [SAFE_RADIUS * 0.93, SIZE / 2];
    const fg = await placedFox(fox.rgba, fox.bounds, radius, SIZE / 2, cy);
    const monoFg = await placedFox(mono, fox.bounds, radius, SIZE / 2, cy);
    await writePng(
      canvas().composite([fg, ...(badge ? [{ input: pillSvg(badge) }] : [])]),
      path.join(dir, 'android-foreground.png'),
    );
    await writePng(
      canvas().composite([monoFg, ...(badge ? [{ input: pillSvg(badge, { knockout: true }) }] : [])]),
      path.join(dir, 'android-monochrome.png'),
    );
  }

  console.log('splash:');
  const splash = await placedFox(fox.rgba, fox.bounds, SIZE * 0.48, SIZE / 2, SIZE / 2);
  await writePng(canvas().composite([splash]), path.join(IMAGES, 'splash-icon.png'));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
