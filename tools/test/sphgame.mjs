/**
 * The SPH fluid in the game (src/fluid): loads the level with the fluid on (WebGPU compute on the real GPU by default,
 * --webgl for the CPU fallback in a worker), checks that the red water tower's tank holds its water and the solver goes
 * to sleep, breaches the tank with a blast, and checks that the water runs out onto the ground (the SDF pages followed
 * the edit), that nothing fell through the terrain, that a box dropped into the pool pushes the water out of it, and
 * that there were no console errors. Measures frame times, GPU compute and render time (timestamp queries, WebGPU
 * only) before, during and after the spill, and the render cost of the fluid (same view with ?fluid=0). Screenshots
 * go to outDir.
 *   node tools/test/sphgame.mjs [outDir] [--url http://127.0.0.1:5180/] [--webgl]   (dev server running)
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : 'shots/sph';
const base = val('--url', 'http://127.0.0.1:5180/');
const webgl = args.includes('--webgl');
fs.mkdirSync(out, { recursive: true });
let fails = 0;
const check = (ok, msg) => { console.log(ok ? '  ok  ' : '  FAIL', msg); if(!ok) fails++; };

const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new',
    args: ['--ignore-gpu-blocklist', '--use-angle=vulkan', '--window-size=1280,720', ...(webgl ? [] : ['--enable-unsafe-webgpu', '--enable-features=Vulkan'])] });

async function open(query) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); else if(/^fluid/.test(m.text())) console.log('  [page]', m.text()); });
    if(!webgl) {
        // the first adapter request of a fresh browser can come back empty: wait until the GPU process has one
        await page.goto(new URL('docs/', base).href).catch(() => {});
        for(let i = 0; i < 40 && !(await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter()))); i++) await new Promise(r => setTimeout(r, 250));
    }
    await page.goto(`${base}?fly=1&bots=0&music=0&profile${query}`);
    await page.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 180000 });
    await page.evaluate(() => {
        window.wait = (ms) => new Promise(r => setTimeout(r, ms));
        window.view = (pos, at) => { ctx.camera.position.set(...pos); ctx.camera.lookAt(...at); };
        /** n frames: frame interval, GPU compute and render time (ms) per frame. */
        window.measure = async (n = 90) => {
            const ts = [], comp = [], rend = [];
            const gpu = ctx.renderer.backend.isWebGPUBackend;
            let last = performance.now(), calls = ctx.renderer.info.compute.calls;
            for(let i = 0; i < n; i++) {
                await new Promise(r => requestAnimationFrame(r));
                const t = performance.now(); ts.push(t - last); last = t;
                if(gpu) {
                    // (with no compute pass since the last read the resolve repeats the previous value)
                    const c = await ctx.renderer.resolveTimestampsAsync('compute'), r = await ctx.renderer.resolveTimestampsAsync('render');
                    const ran = ctx.renderer.info.compute.calls !== calls; calls = ctx.renderer.info.compute.calls;
                    if(typeof c === 'number') comp.push(ran ? c : 0); if(typeof r === 'number') rend.push(r);
                }
            }
            const q = (a, f) => { if(!a.length) return null; const b = [...a].sort((x, y) => x - y); return +b[Math.min(b.length - 1, Math.floor(b.length * f))].toFixed(3); };
            const f = ctx.fluid;
            return { fps: +(1000 / q(ts, 0.5)).toFixed(1), frameMed: q(ts, 0.5), frameP95: q(ts, 0.95), computeMed: q(comp, 0.5), computeP95: q(comp, 0.95),
                renderMed: q(rend, 0.5), calls: ctx.renderer.info.render.drawCalls, awake: f?.awake, alive: f?.stats?.alive, moving: f?.stats?.moving,
                workerMs: f?.sim?.cpu ? +f.sim.stats.workerMs.toFixed(2) : undefined };
        };
        /** The particles (xyz, phase), read back once (tests only: the game never reads them). */
        window.particles = async () => {
            const sim = ctx.fluid.sim;
            if(sim.cpu) { await wait(200); return Array.from(sim.posAttr.array.subarray(0, sim.extent * 4)); }
            const b = await ctx.renderer.getArrayBufferAsync(sim.pos.value);
            return Array.from(new Float32Array(b).subarray(0, sim.extent * 4));
        };
        window.grab = () => new Promise(res => requestAnimationFrame(() => res(ctx.renderer.domElement.toDataURL('image/png'))));
    });
    return { page, errors };
}
const save = async (page, name) => {
    const d = await page.evaluate(() => window.grab());
    fs.writeFileSync(`${out}/${name}.png`, Buffer.from(d.split(',')[1], 'base64'));
};

const TANK = [-71, -13], R_OUT = 2.6;
const VIEW_TOWER = [[-58, 16, 2], [-70, 3, -12]];
const VIEW_LOW = [[-62, 4, -2], [-71, 3, -13]];
const { page, errors } = await open('');
const info = await page.evaluate(() => ({ backend: ctx.renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2', label: ctx.fluid.label, extent: ctx.fluid.sim.extent,
    sources: ctx.fluid.sources.map(s => `${s.kind} ${s.count}`), settings: ctx.fluid.settings }));
console.log('fluid:', JSON.stringify(info));
check(info.backend === (webgl ? 'WebGL2' : 'WebGPU'), `backend ${info.backend}`);

// ---- the tank holds and the solver goes to sleep
const tankCount = async () => page.evaluate(async (T, R) => {
    const p = await particles();
    let inside = 0, outside = 0, buried = 0, water = 0;
    for(let i = 0; i < p.length; i += 4) {
        if(p[i + 3] !== 1) continue;
        water++;
        const d = Math.hypot(p[i] - T[0], p[i + 2] - T[1]);
        if(d < 12) { if(d < R && p[i + 1] > 5.9) inside++; else outside++; }
        if(ctx.world.sample(p[i], p[i + 1], p[i + 2]) < -0.15) buried++;
    }
    return { inside, outside, buried, water };
}, TANK, R_OUT);
await page.evaluate((v) => view(...v), VIEW_TOWER);
await page.evaluate(() => wait(1500));
let calm = await page.evaluate(async () => { for(let i = 0; i < 40 && ctx.fluid.awake; i++) await wait(250); return !ctx.fluid.awake; });
const t0 = await tankCount();
console.log('before the breach:', JSON.stringify(t0));
check(t0.outside === 0 && t0.inside > 500, `the tank holds its water (${t0.inside} inside, ${t0.outside} outside)`);
check(calm, 'the solver sleeps once the water is calm');
const before = await page.evaluate(() => measure(90));
console.log('calm (asleep):', JSON.stringify(before));
await save(page, 'tower-before');
await page.evaluate((v) => view(...v), VIEW_LOW);
await save(page, 'tower-before-low');
await page.evaluate((v) => view(...v), VIEW_TOWER);

// ---- breach the tank: a blast on its wall, low on the side facing the fort
await page.evaluate(() => ctx.destruction.blast([-69.0, 6.9, -11.0], 2.2));
await page.evaluate(() => wait(700));
await save(page, 'tower-breach-0.7s');
const during = await page.evaluate(() => measure(120));
console.log('spilling:', JSON.stringify(during));
await save(page, 'tower-breach-2.5s');
await page.evaluate(() => wait(3500));
await save(page, 'tower-after-6s');
await page.evaluate((v) => view(...v), VIEW_LOW);
await save(page, 'tower-after-low');
const t1 = await tankCount();
console.log('after the breach:', JSON.stringify(t1));
check(t1.outside > t0.inside * 0.3, `the water ran out of the breached tank (${t1.outside} of ${t0.inside} outside)`);
check(t1.buried <= Math.max(3, t1.water * 0.002), `no water inside the terrain (${t1.buried})`);
check(t1.water >= t0.water * 0.97, `no water lost (${t1.water} of ${t0.water})`);

// ---- a box dropped into the pool pushes the water out of it
const pool = await page.evaluate(async () => {
    // the pool's middle: the centre of the water outside the tank
    const p = await particles();
    let sx = 0, sz = 0, n = 0;
    for(let i = 0; i < p.length; i += 4) {
        const d = Math.hypot(p[i] + 71, p[i + 2] + 13);
        if(p[i + 3] === 1 && d > 3 && d < 12) { sx += p[i]; sz += p[i + 2]; n++; }
    }
    return [sx / n, 0, sz / n];
});
const pushed = await page.evaluate(async (c) => {
    // the fly camera's B key drops a 1 m box 3 m ahead of the camera: look straight down from above the pool
    ctx.camera.position.set(c[0], 7, c[2]); ctx.camera.lookAt(c[0], 0, c[2] + 0.001);
    const had = new Set(ctx.physics.props);
    dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB' }));
    const prop = [...ctx.physics.props].find(p => !had.has(p));
    if(!prop) return { error: 'no box', inside: -1, near: 0 };
    await wait(2500);
    const mesh = prop.mesh, s = 0.5;
    mesh.updateMatrixWorld();
    const inv = mesh.matrixWorld.clone().invert();
    const p = await particles();
    let inside = 0, near = 0;
    const v = mesh.position.clone();
    for(let i = 0; i < p.length; i += 4) {
        if(p[i + 3] === 0) continue;
        v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(inv);
        const m = Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
        if(m < s - 0.08) inside++; else if(m < s + 0.5) near++;
    }
    const t = prop.body.translation();
    return { at: [t.x, t.y, t.z].map(x => +x.toFixed(2)), inside, near };
}, pool);
console.log('box in the pool:', JSON.stringify(pushed));
check(pushed.inside <= 2 && pushed.near > 20, `a body pushes the water out of its volume (${pushed.inside} particles inside, ${pushed.near} around it)`);
await page.evaluate((c) => view([c[0] + 3, 3.5, c[2] + 4], [c[0], 0.5, c[2]]), pool);
await save(page, 'box-in-pool');

// ---- the dev spawn and the cap
const spawn = await page.evaluate(async () => {
    view([-40, 25, 25], [-55, 0, 0]);
    let n = 0;
    for(let i = 0; i < 40; i++) n += ctx.fluid.spawnBlob([-60 + (i % 6) * 4, 6 + Math.floor(i / 6) * 2.2, -6 + (i % 5) * 3], { n: 9 });
    await wait(500);
    const falling = await measure(90);
    await wait(3000);
    return { spawned: n, extent: ctx.fluid.sim.extent, cap: ctx.fluid.cap, falling, flowing: await measure(90) };
});
console.log('spawned to the cap:', JSON.stringify(spawn));
await save(page, 'courtyard-full');
const after = await page.evaluate(async (v) => { view(...v); await wait(500); return measure(60); }, VIEW_TOWER);
await page.close();

// ---- render cost: the same view of the spilled water without the fluid
let renderCost = null;
if(!webgl) {
    const { page: p2, errors: e2 } = await open('&fluid=0');
    const off = await p2.evaluate(async (v) => { view(...v); await wait(1500); return measure(60); }, VIEW_TOWER);
    renderCost = { fluidOff: off.renderMed, fluidOn: after.renderMed, callsOff: off.calls, callsOn: after.calls };
    console.log('render with and without the fluid (same view):', JSON.stringify(renderCost));
    errors.push(...e2);
    await p2.close();
}

const fpsOk = (m) => m.fps >= 58;
check(fpsOk(before) && fpsOk(during) && fpsOk(spawn.falling) && fpsOk(spawn.flowing), `60 fps throughout (${before.fps}, ${during.fps}, ${spawn.falling.fps}, ${spawn.flowing.fps})`);
if(!webgl) check(spawn.flowing.computeMed < 2, `GPU compute under 2 ms at ${spawn.extent} particles (${spawn.flowing.computeMed} ms median)`);
const real = errors.filter(e => !/404|Failed to load resource/.test(e));
check(real.length === 0, `no console errors${real.length ? ': ' + [...new Set(real)].slice(0, 5).join(' | ') : ''}`);
console.log(JSON.stringify({ backend: info.backend, particles: info.extent, before, during, spawn, renderCost }));
console.log(fails ? `${fails} FAILED` : 'all ok', `(screenshots in ${out})`);
await browser.close();
process.exit(fails ? 1 : 0);
