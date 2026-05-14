import polyfills from '@frida/rollup-plugin-node-polyfills';
import terser from '@rollup/plugin-terser';
import resolve from '@rollup/plugin-node-resolve';
import { defineConfig } from 'rollup';

export default defineConfig({
  input: 'index.js',
  output: [
    {
      file: '_agent.js',
      format: 'iife',
      name: 'FridaJavaBridge',
      exports: 'default',
      generatedCode: {
        preset: 'es2015'
      },
      strict: false,
      sourcemap: false,
      footer: "Object.defineProperty(globalThis, 'Java', { value: FridaJavaBridge });\nJava.perform = Java.performNow.bind(Java);\nconsole.log(Java);"
    },
    {
      file: 'java.js',
      format: 'iife',
      name: 'bridge',
      exports: 'default',
      generatedCode: {
        preset: 'es2015'
      },
      strict: false,
      sourcemap: false,
      footer: 'bridge.perform = bridge.performNow.bind(bridge);'
    }
  ],
  plugins: [
    polyfills(),
    resolve(),
    terser({ ecma: 2022 })
  ],
  treeshake: {
    moduleSideEffects: false
  }
});
