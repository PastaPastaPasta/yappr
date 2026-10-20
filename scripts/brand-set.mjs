// The rules a brand set (public/brand/, docs/brand/candidates/<style>/) must follow, shared by
// scripts/brand-assets.mjs and its test. See docs/brand/README.md.
import fs from 'node:fs';
import path from 'node:path';

/** Every set has these; the -dark files are the light ones' counterparts for dark backgrounds. */
export const FILES = [
  'mark.svg',
  'mark-dark.svg',
  'mark-mono.svg',
  'wordmark.svg',
  'wordmark-dark.svg',
  'lockup.svg',
  'lockup-dark.svg',
  'favicon.svg',
  'app-icon.svg',
  'app-icon-foreground.svg',
  'powered-by.svg',
  'powered-by-dark.svg',
];

/** The viewBox height (or exact size) each file's geometry is drawn for. */
const SHAPES = {
  'mark.svg': [64, 64],
  'mark-dark.svg': [64, 64],
  'mark-mono.svg': [64, 64],
  'wordmark.svg': [null, 64],
  'wordmark-dark.svg': [null, 64],
  'lockup.svg': [null, 64],
  'lockup-dark.svg': [null, 64],
  'favicon.svg': [32, 32],
  'app-icon.svg': [1024, 1024],
  'app-icon-foreground.svg': [1024, 1024],
  'powered-by.svg': [null, 32],
  'powered-by-dark.svg': [null, 32],
};

export function viewBox(svg) {
  const match = /viewBox="([\d.\s-]+)"/.exec(svg);
  if (!match) return null;
  const [, , width, height] = match[1].trim().split(/\s+/).map(Number);
  return { width, height };
}

/** Width over height, to three decimals. */
export function ratioOf(svg) {
  const { width, height } = viewBox(svg);
  return Math.round((width / height) * 1000) / 1000;
}

/** What's wrong with the set in `dir`, as messages (empty when it can be installed). */
export function problems(dir) {
  const found = [];
  for (const file of [...FILES, 'brand.json']) {
    if (!fs.existsSync(path.join(dir, file))) found.push(`missing ${file}`);
  }
  if (found.length) return found;
  for (const file of FILES) {
    const svg = fs.readFileSync(path.join(dir, file), 'utf8');
    // react-native-svg's SvgXml ignores <style>, and <text> depends on the viewer's fonts.
    if (/<(style|text|image)\b|\bclass="/.test(svg)) found.push(`${file} uses <style>, <text>, <image> or class=`);
    const box = viewBox(svg);
    const [width, height] = SHAPES[file];
    if (!box) found.push(`${file} has no viewBox`);
    else if (box.height !== height || (width !== null && box.width !== width)) {
      found.push(`${file} viewBox is ${box.width}x${box.height}, expected ${width ?? 'any'}x${height}`);
    }
  }
  const { baseline } = JSON.parse(fs.readFileSync(path.join(dir, 'brand.json'), 'utf8'));
  if (typeof baseline !== 'number' || baseline <= 0 || baseline >= 64) found.push('brand.json needs a numeric baseline (0-64)');
  return found;
}
