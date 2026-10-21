/**
 * Headless WebGPU (SwiftShader) check of SoftGround end to end: wake -> GPU sim -> sleep -> readback -> bake in the
 * worker -> terrain worker -> remesh with skip tags -> slot freed. node tools/test/softgame.mjs [outPrefix] ['{"speed":9}']
 */
import puppeteer from 'puppeteer-core';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const out = process.argv[2] || '/tmp/softg';
const opts = JSON.parse(process.argv[3] || '{}');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'softgame-'));
await build({ entryPoints: ['tools/test/softGamePage.js'], bundle: true, format: 'esm', outfile: path.join(dir, 'page.js'), logLevel: 'error' });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU'] });
const page = await browser.newPage();
page.on('console', m => { const t = m.text(); if(!/GPU stall|404|Failed to load/.test(t)) console.log('[console]', m.type(), t.slice(0, 300)); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:5180/dist/test.html').catch(() => {}); // a 404 page under /dist: workers resolve
await page.addScriptTag({ content: fs.readFileSync(path.join(dir, 'page.js'), 'utf8'), type: 'module' });
await page.waitForFunction(() => window.setup, { timeout: 30000 });
console.log('setup', JSON.stringify(await page.evaluate((o) => window.setup(o), opts)));
const save = async (name) => { const d = await page.evaluate(() => window.grab()); fs.writeFileSync(`${out}-${name}.png`, Buffer.from(d.split(',')[1], 'base64')); };
const p = opts.point || [-28, 0, -3];
const y0 = await page.evaluate((p) => window.surfaceY(p[0], p[2]), p);
await page.evaluate(() => window.frame(2));
await new Promise(r => setTimeout(r, 2500)); // textures
await page.evaluate(() => window.frame(1));
await save('0');
await page.evaluate((o, p) => window.__g.soft.wake([p[0], p[1], p[2]], { speed: o.speed || 9, radius: o.radius || 2.5, dir: o.dir || null, up: o.up ?? 0.45 }), opts, p);
let f = 0;
for(const step of opts.steps || [2, 4, 6, 10, 20, 30, 40, 60, 80]) {
    const r = await page.evaluate((n) => window.frame(n), step - f); f = step;
    console.log(`frame ${f}`, JSON.stringify(r));
    await save(String(f).padStart(3, '0'));
}
// wait for the bake and remesh
for(let i = 0; i < 20; i++) {
    const r = await page.evaluate(() => window.frame(3));
    if(!r.zones.length) { console.log('settled', JSON.stringify(r)); break; }
    if(i % 4 === 0) console.log('waiting', JSON.stringify(r));
    await new Promise(r => setTimeout(r, 100));
}
await save('end');
const y1 = await page.evaluate((p) => window.surfaceY(p[0], p[2]), p);
console.log('surface y before', y0, 'after', y1);
await browser.close();
