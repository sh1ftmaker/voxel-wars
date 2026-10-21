/** Dev server: esbuild watch of src/main.js and src/workers/*.js into dist/, plus a static file server.
 *  `PORT=5180 node tools/dev.mjs` (default 5180). `node tools/build.mjs` makes a one-off build. */
import { context } from 'esbuild';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { buildOptions } from './build.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ctx = await context(buildOptions);
await ctx.watch();
const PORT = +(process.env.PORT || 5180);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.map': 'application/json', '.mp3': 'audio/mpeg', '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if(p.endsWith('/')) p += 'index.html';
    const f = path.join(root, path.normalize(p));
    if(!f.startsWith(root)) { res.writeHead(403); res.end(); return; }
    fs.readFile(f, (err, data) => {
        if(err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(data);
    });
}).listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT}/`));
