/**
 * Frame-time profiler: headless Chromium with vsync and the frame limiter off, a scripted scenario, and per-frame
 * timings. `node tools/profile.mjs [url] [seconds] [--trace out.json] [--scenario idle|blasts|topple]`
 *
 * Reports frame time percentiles, the worst frames, long tasks (>16 ms main-thread tasks), and with --cpu the
 * hottest functions from a CPU profile taken over the run. The scenario is driven through window.ctx.
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const url = args.find(a => a.startsWith('http')) || 'http://127.0.0.1:5180/?fly=1&bots=0';
const seconds = +(args.find(a => /^\d+$/.test(a)) || 12);
const scenario = flag('--scenario', 'blasts');
const cpu = args.includes('--cpu');

const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium', headless: 'new',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--ignore-gpu-blocklist', '--window-size=1280,720',
        '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('console', m => { if(m.type() === 'error') console.log('[console.error]', m.text()); });
await page.goto(url);
await page.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 60000 });
await new Promise(r => setTimeout(r, 1500));

const client = await page.createCDPSession();
if(cpu) { await client.send('Profiler.enable'); await client.send('Profiler.setSamplingInterval', { interval: 200 }); await client.send('Profiler.start'); }

const res = await page.evaluate(async (seconds, scenario) => {
    const ctx = window.ctx, frames = [], longTasks = [];
    try { new PerformanceObserver(l => { for(const e of l.getEntries()) longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask' }); } catch {}
    const t0 = performance.now();
    let last = t0, i = 0;
    const cam = ctx.camera;
    // a path across the battlefield, looking ahead
    const path = (t) => [-60 + t * 9, 9 + Math.sin(t * 0.7) * 3, Math.sin(t * 0.4) * 12];
    let nextBlast = 1.0, seed = 1;
    await new Promise(resolve => {
        const tick = (now) => {
            frames.push(now - last); last = now;
            const t = (now - t0) / 1000;
            if(scenario !== 'idle') {
                const p = path(t), q = path(t + 0.5);
                cam.position.set(...p); cam.lookAt(q[0], q[1] - 3, q[2]);
            }
            if(scenario === 'blasts' && t > nextBlast) {
                nextBlast += 0.35;
                const d = [Math.sin(seed) * 0.3, -0.5, Math.cos(seed) * 0.3]; seed++;
                const l = Math.hypot(...d); for(let k = 0; k < 3; k++) d[k] /= l;
                const fwd = [0, 0, -1]; // camera forward
                const v = cam.getWorldDirection(new cam.position.constructor());
                const hit = ctx.world.raycast(cam.position.toArray(), [v.x + d[0] * 0.3, v.y - 0.3, v.z + d[2] * 0.3].map((x, _, a) => x / Math.hypot(...a)), 60);
                if(hit) ctx.destruction.blast(hit.point, 2.4 + (seed % 3));
            }
            if(scenario === 'topple' && i === 30) { for(const z of [12.6, -12.4]) ctx.destruction.blast([-36.4, 1.2, z], 3.5); }
            i++;
            if(t < seconds) requestAnimationFrame(tick); else resolve();
        };
        requestAnimationFrame(tick);
    });
    return { frames, longTasks, bodies: ctx.physics.props.size };
}, seconds, scenario);

if(cpu) {
    const { profile } = await client.send('Profiler.stop');
    const self = new Map();
    const byId = new Map(profile.nodes.map(n => [n.id, n]));
    const dt = new Map();
    for(let k = 0; k < profile.samples.length; k++) dt.set(profile.samples[k], (dt.get(profile.samples[k]) || 0) + (profile.timeDeltas[k] || 0));
    for(const [id, us] of dt) { const n = byId.get(id); const f = n.callFrame; const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`; self.set(key, (self.get(key) || 0) + us); }
    const total = [...self.values()].reduce((a, b) => a + b, 0);
    console.log('\nTop self time:');
    for(const [k, us] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${(us / 1000).toFixed(0).padStart(7)} ms ${(us / total * 100).toFixed(1).padStart(5)}%  ${k}`);
    if(flag('--trace')) fs.writeFileSync(flag('--trace'), JSON.stringify(profile));
}

const f = res.frames.slice(5).sort((a, b) => a - b);
const pct = (p) => f[Math.min(f.length - 1, Math.floor(f.length * p))].toFixed(2);
const mean = f.reduce((a, b) => a + b, 0) / f.length;
console.log(`\n${scenario}: ${f.length} frames, mean ${mean.toFixed(2)} ms (${(1000 / mean).toFixed(0)} fps), p50 ${pct(0.5)} p90 ${pct(0.9)} p99 ${pct(0.99)} max ${f[f.length - 1].toFixed(1)} ms`);
console.log(`frames > 8.3 ms: ${f.filter(x => x > 8.3).length}, > 16.7 ms: ${f.filter(x => x > 16.7).length}, > 33 ms: ${f.filter(x => x > 33).length}; bodies at end ${res.bodies}`);
console.log('long tasks [start, ms]:', JSON.stringify(res.longTasks.slice(0, 30)));
await browser.close();
