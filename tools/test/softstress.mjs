/** Soft ground lifecycle stress (headless SwiftShader WebGPU harness, see softgame.mjs): many wakes, overlaps, a
 *  carve inside a live zone, then everything must settle and free its slots without errors. */
import puppeteer from 'puppeteer-core';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'softstress-'));
await build({ entryPoints: ['tools/test/softGamePage.js'], bundle: true, format: 'esm', outfile: path.join(dir, 'page.js'), logLevel: 'error' });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU'] });
const page = await browser.newPage();
let errors = 0;
page.on('console', m => { const t = m.text(); if(m.type() === 'error' && !/404|Failed to load/.test(t)) { errors++; console.log('[error]', t.slice(0, 300)); } });
page.on('pageerror', e => { errors++; console.log('[pageerror]', e.message); });
await page.goto('http://127.0.0.1:5180/dist/test.html').catch(() => {});
await page.addScriptTag({ content: fs.readFileSync(path.join(dir, 'page.js'), 'utf8'), type: 'module' });
await page.waitForFunction(() => window.setup, { timeout: 30000 });
await page.evaluate(() => window.setup({}));
await page.evaluate(() => window.frame(3));
await page.evaluate(() => { const n = window.__g.renderer._nodes, o = n._createNodeBuilder.bind(n); window.__builds = 0; n._createNodeBuilder = (...a) => { window.__builds++; return o(...a); }; });
const spots = [[-28, 0, -3], [-26, 0, -2], [-20, 0, -3], [-34, 0, 3], [-58, 0.1, 6], [-12, 0, 0], [-40, 6, -12], [-28, 0, 6]];
for(let i = 0; i < 14; i++) {
    const p = spots[i % spots.length];
    await page.evaluate((p, i) => window.__g.soft.wake(p, { speed: 6 + (i % 4) * 2, radius: 1.5 + (i % 3), up: 0.3, dir: i % 5 === 0 ? [0, -1, 0] : null }), p, i);
    const r = await page.evaluate(() => window.frame(4));
    console.log(i, r.zones.map(z => `${z.slot}:${z.state}`).join(' '), 'cpu avg', r.stats.cpuMs.toFixed(3), 'max', r.stats.cpuMax.toFixed(3));
}
// a world edit inside a live zone: the zone re-reads its lattice
await page.evaluate(() => { const g = window.__g; for(const fn of g.ctx.destruction.editHooks) fn({ op: 'carve', center: [-28, 0, -3], size: 1, impulse: 0, kind: 'carve', box: [[-29, -1, -4], [-27, 1, -2]] }); });
for(let i = 0; i < 60; i++) {
    const r = await page.evaluate(() => window.frame(4));
    if(!r.zones.length) { console.log('all settled after', i * 4, 'frames', JSON.stringify(r.stats)); break; }
    if(i % 10 === 0) console.log('t', i * 4, r.zones.map(z => `${z.slot}:${z.state}`).join(' '));
    await new Promise(r => setTimeout(r, 30));
}
console.log('errors', errors, 'material builds during the run', await page.evaluate(() => window.__builds));
await browser.close();
