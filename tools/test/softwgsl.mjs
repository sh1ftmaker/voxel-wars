/** Compiles the soft debris body material's WGSL (vertex: the lattice deformation) with WebGPU and prints the
 *  compiler's messages. Headless WebGPU here cannot draw the game, but it generates and compiles shaders. node tools/test/softwgsl.mjs [url] */
import puppeteer from 'puppeteer-core';
const url = process.argv[2] || 'http://127.0.0.1:5180/?fly=1&bots=0&music=0';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU'] });
const page = await browser.newPage();
await page.goto(url);
await page.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 120000 });
const res = await page.evaluate(async () => {
    const r = ctx.renderer;
    if(!r.backend.isWebGPUBackend) return { backend: 'WebGL2' };
    // a body: rip a lump out of the field, wait for its mesh
    const vb = ctx.destruction.bodies.rip(ctx.destruction.brushes.sphere([12, 0, 0], 1.2));
    await vb.meshed;
    const { vertexShader, fragmentShader } = await r.debug.getShaderAsync(ctx.scene, ctx.camera, vb.mesh);
    return { backend: 'WebGPU', vertexShader, fragmentShader };
});
if(res.backend !== 'WebGPU') { console.log('no WebGPU here'); process.exit(1); }
// compile on a fresh device in a blank page (the game's device does not last long headless)
const blank = await browser.newPage();
await blank.goto(new URL('/assets/', url).href);
const out = await blank.evaluate(async (shaders) => {
    const d = await (await navigator.gpu.requestAdapter()).requestDevice();
    const r = {};
    for(const [k, code] of Object.entries(shaders)) {
        const info = await d.createShaderModule({ code }).getCompilationInfo();
        r[k] = { lines: code.split('\n').length, atlasFetches: (code.match(/textureLoad/g) || []).length, messages: info.messages.map(x => `${x.type} ${x.lineNum}:${x.linePos} ${x.message}`) };
    }
    return r;
}, { vertex: res.vertexShader, fragment: res.fragmentShader });
console.log(JSON.stringify(out, null, 1));
const bad = Object.values(out).some(o => o.messages.some(m => m.startsWith('error')));
console.log(bad ? 'FAIL' : 'PASS: compiles');
await browser.close();
