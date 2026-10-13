import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { cli: 'src/cli/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    clean: true,
    splitting: false,
    banner: { js: '' },
  },
  {
    entry: { index: 'src/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    splitting: false,
    dts: true,
  },
]);
