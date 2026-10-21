/** One-off build of the client bundle and its workers into dist/. Imported by tools/dev.mjs for the same options. */
import { build } from 'esbuild';
import fs from 'node:fs';

const workers = fs.existsSync('src/workers') ? fs.readdirSync('src/workers').filter(f => f.endsWith('.js')).map(f => `src/workers/${f}`) : [];
export const buildOptions = {
    entryPoints: ['src/main.js', ...workers],
    outdir: 'dist', entryNames: '[name]',
    bundle: true, format: 'esm', target: 'es2022', sourcemap: true, logLevel: 'info',
    minify: process.argv.includes('--minify'),
};
if(import.meta.url === `file://${process.argv[1]}`) await build(buildOptions);
