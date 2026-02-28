import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';

const banner = '/* @yappr/embed v0.1.0 */';

export default {
  input: 'src/index.ts',
  output: [
    {
      file: 'dist/yappr-embed.min.js',
      format: 'umd',
      name: 'YapprEmbed',
      sourcemap: true,
      banner
    },
    {
      file: 'dist/yappr-embed.esm.js',
      format: 'esm',
      sourcemap: true,
      banner
    }
  ],
  plugins: [
    resolve({ browser: true }),
    commonjs(),
    typescript({ tsconfig: './tsconfig.json' }),
    terser()
  ]
};
