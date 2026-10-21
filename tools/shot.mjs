/** Headless check: node tools/shot.mjs [url] [out.png] [waitMs] [js-to-eval-after-load]. Prints console output. */
import puppeteer from 'puppeteer-core';
const [url = 'http://127.0.0.1:5180/', out = 'shot.png', wait = '6000', evalJs] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--window-size=1280,720'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on('console', m => console.log('[console]', m.type(), m.text()));
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(url);
await new Promise(r => setTimeout(r, +wait));
if(evalJs) { console.log('[eval]', await page.evaluate(evalJs)); await new Promise(r => setTimeout(r, 1500)); }
await page.screenshot({ path: out });
await browser.close();
