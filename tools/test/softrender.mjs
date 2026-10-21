/** Headless WebGPU render check of the deforming terrain material: node tools/test/softrender.mjs outPrefix '{"speed":8}' */
import puppeteer from 'puppeteer-core';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const out = process.argv[2] || '/tmp/softr';
const opts = JSON.parse(process.argv[3] || '{}');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'softsim-'));
await build({ entryPoints: ['tools/test/softSimPage.js'], bundle: true, format: 'esm', outfile: path.join(dir, 'page.js'), logLevel: 'error' });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--window-size=820,480'] });
const page = await browser.newPage();
await page.setViewport({ width: 800, height: 450 });
page.on('console', m => { if(!/GPU stall/.test(m.text())) console.log('[console]', m.type(), m.text().slice(0, 300)); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:5180/favicon.ico').catch(() => {}); // same origin (textures), no game
await page.evaluate(() => { document.body.innerHTML = ''; document.body.style.margin = 0; });
await page.addScriptTag({ content: fs.readFileSync(path.join(dir, 'page.js'), 'utf8'), type: 'module' });
await page.waitForFunction(() => window.setupRender, { timeout: 30000 });
console.log(await page.evaluate((o) => window.setupRender(o), opts));
await page.evaluate(() => window.step(3));
await new Promise(r => setTimeout(r, 3000)); // textures
await page.evaluate(() => window.step(1));
const save = async (name) => { const d = await page.evaluate(() => window.grab()); fs.writeFileSync(`${out}-${name}.png`, Buffer.from(d.split(',')[1], 'base64')); };
await save(0);
await page.evaluate((o) => window.kick(o), opts);
let last = 0;
for(const f of opts.frames || [3, 8, 14, 24, 60]) {
    console.log('frame', f, 'max|u|', await page.evaluate((f) => window.step(f), f - last)); last = f;
    await save(f);
}
await browser.close();
