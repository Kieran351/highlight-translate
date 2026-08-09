import { build } from 'vite';
import { resolve } from 'node:path';

const root = process.cwd();
const watch = process.argv.includes('--watch') ? {} : undefined;

const shared = {
  root,
  logLevel: 'info',
  build: {
    target: 'chrome120',
    sourcemap: false,
    minify: false,
    watch,
  },
};

await build({
  ...shared,
  build: {
    ...shared.build,
    outDir: 'dist',
    emptyOutDir: true,
    copyPublicDir: true,
    rollupOptions: {
      input: resolve(root, 'options.html'),
      output: {
        entryFileNames: 'options/options.js',
        chunkFileNames: 'shared/[name].js',
        assetFileNames: 'options/[name][extname]',
      },
    },
  },
});

await build({
  ...shared,
  publicDir: false,
  build: {
    ...shared.build,
    outDir: 'dist',
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: resolve(root, 'src/background/service-worker.ts'),
      formats: ['es'],
      fileName: () => 'background/service-worker.js',
    },
  },
});

await build({
  ...shared,
  publicDir: false,
  build: {
    ...shared.build,
    outDir: 'dist',
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: resolve(root, 'src/content/content-script.ts'),
      name: 'HighlightTranslateContent',
      formats: ['iife'],
      fileName: () => 'content/content-script.js',
    },
  },
});

if (watch) {
  console.info('Highlight Translate 正在监听文件变化。');
} else {
  await import('./verify-dist.mjs');
}
