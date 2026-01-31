/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import { run } from 'vite-plugin-run';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  root: 'src',
  publicDir: '../assets',
  server: {
  },
  plugins: [
  ],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['../test/**/*.test.ts', '**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.{idea,git,cache,output,temp}/**', '**/e2e/**'],
    pool: 'forks',
    forks: {
      singleFork: true,
      isolate: true,
    },
    fileParallelism: false,
  },
  define: {
    'import.meta.env.GOOGLE_API_KEY': JSON.stringify(process.env.GOOGLE_API_KEY),
    // 'import.meta.env.VITE_DB_NAME': JSON.stringify('notes-app'),
  },
});
