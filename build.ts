import * as esbuild from 'esbuild';

esbuild
  .build({
    entryPoints: ['src/index.ts'],
    mainFields: ['module', 'main'],
    platform: 'node',
    external: ['readline/promises'],
    bundle: true,
    outdir: 'dist',
    watch: process.argv.includes('--watch') || process.argv.includes('-w'),
  })
  .catch((e) => {
    console.warn(e);
    return process.exit(1);
  });
