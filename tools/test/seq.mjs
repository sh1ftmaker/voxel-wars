/** node tools/test/seq.mjs <url> <outPrefix> <waitMs> <setupJs> [shots=4] [intervalMs=700] [probeJs]
 *  Like tools/shot.mjs but takes a sequence of screenshots after running setupJs (not awaited past its promise),
 *  printing probeJs's value at every shot. */
import puppeteer from 'puppeteer-core';
const [url, out, wait = '7000', setup, shots = '4', every = '700', probe = 'ctx.physics.props.size'] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--window-size=1280,720'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on('console', m => { const t = m.text(); if(!/GL Driver|WebGPU is not|Instance reference/.test(t)) console.log('[console]', t); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(url);
await new Promise(r => setTimeout(r, +wait));
console.log('[setup]', await page.evaluate(setup));
for(let i = 0; i < +shots; i++) {
  await new Promise(r => setTimeout(r, +every));
  console.log(`[shot ${i}]`, await page.evaluate(probe));
  await page.screenshot({ path: `${out}-${i}.png` });
}
await browser.close();
