const { platformSelect } = require('nativewind/theme');

/**
 * The web's tailwind.config.js is the design-token source of truth (ADR-001
 * E3). Using it as a preset gives mobile the same `yappr-*` ramp,
 * `neutral-750/850`, `shadow-yappr*` and gradients. Its `content` globs are
 * replaced by ours below, and so is `darkMode`: the web scopes its dark
 * variant (a `theme-light` wrapper turns it off inside a blog post), but
 * NativeWind needs plain `'class'` to let Settings override the system scheme.
 */
const webTheme = require('../../tailwind.config.js');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  presets: [require('nativewind/preset'), webTheme],
  theme: {
    extend: {
      fontFamily: {
        // The web stack (-apple-system, Roboto, ...) is not a valid native
        // font name; these are the same faces under their native names.
        sans: platformSelect({ ios: 'System', android: 'sans-serif', default: 'System' }),
      },
    },
  },
};
