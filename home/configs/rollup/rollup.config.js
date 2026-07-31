import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import postcss from 'rollup-plugin-postcss';

export default {
  input: [
    '/home/code/scripts.js',
  ],
  output: {
    file: '/home/code/scripts-bundle.js',
    format: 'iife',
    globals: {}
  },
  plugins: [
    resolve({
      modulePaths: ['./node_modules'],
      browser: true,
      preferBuiltins: false
    }),
    commonjs({
      include: /node_modules/,
      transformMixedEsModules: true
    }),
    postcss({
      extract: true,
    })
  ]
};