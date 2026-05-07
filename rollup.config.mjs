import polyfills from '@frida/rollup-plugin-node-polyfills';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import resolve from '@rollup/plugin-node-resolve';
import { defineConfig } from 'rollup';

export default defineConfig({
  input: 'index.js',
  output: {
    file: '_agent.js',
    format: 'iife',
    name: 'FridaJavaBridge',
    exports: 'default',
    generatedCode: {
      preset: 'es2015'
    },
    strict: false,
    sourcemap: false,
    footer: "Java.perform = Java.performNow.bind(Java);"
  },
  plugins: [
    resolve(),
    commonjs({
      transformMixedEsModules: true
    }),
    polyfills({ include: '**/*.js' }),
    terser({ ecma: 2022 })
  ],
  treeshake: {
    moduleSideEffects: false
  }
});
