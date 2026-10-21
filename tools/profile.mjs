/**
 * Frame-time profiler: headless Chromium with vsync and the frame limiter off, a scripted scenario, and per-frame
 * timings. `node tools/profile.mjs [url] [seconds] [--scenario idle|blasts|topple|dig|game] [--cpu] [--trace out.json]
 *   [--who fnName] [--json out.json]`
 *
 * Per frame it records:
 *   - the frame interval (requestAnimationFrame delta; with a real GPU this includes GPU waits)
 *   - main-thread CPU: every requestAnimationFrame callback plus every worker message handler since the last frame
 *     (both are wrapped before the page loads), which is what the game's own code costs
 *   - a breakdown by section (destruction.carve, world.applyBrush, physics.step, b3.step, colliders, voxel body jobs,
 *     terrain mesh uploads, systems, render), wrapped on the live objects after loading
 * and reports p50 / p99 / max of each, the worst frames with their breakdown, long tasks, JS heap growth, and with
 * --cpu the hottest functions (self time) from a CPU profile; --who NAME also prints NAME's callers.
 *
 * Scenarios (driven through window.ctx):
 *   idle     nothing happens (camera still)
 *   blasts   the camera flies across the level and fires a 2.4-4.4 m blast every 0.35 s where it looks
 *   topple   a brick bridge is built in the field and its pillars are cut: the 18 m deck falls 4.5 m, fractures on
 *            impact and the pieces settle (twice, at x = 0 and x = 30)
 *   dig      flying camera: drill-sized capsule carves 8x per second plus a rock bite every 0.5 s
 *   game     the real game (use the default URL with bots): the player fires rockets at the enemy fort every 0.9 s
 *            and drills every 0.36 s, while the bots play
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const scenario = flag('--scenario', 'blasts');
const url = args.find(a => a.startsWith('http')) || (scenario === 'game' ? 'http://127.0.0.1:5180/' : 'http://127.0.0.1:5180/?fly=1&bots=0');
const seconds = +(args.find(a => /^\d+$/.test(a)) || 12);
const cpu = args.includes('--cpu');
const webgl = args.includes('--webgl');

const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium', headless: 'new',
    args: [...(webgl ? [] : ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU']), '--ignore-gpu-blocklist', '--window-size=1280,720',
        '--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const errors = new Map();
page.on('pageerror', e => errors.set(e.message, (errors.get(e.message) || 0) + 1));
page.on('console', m => { if(m.type() === 'error') errors.set(m.text(), (errors.get(m.text()) || 0) + 1); });
if(webgl) await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'gpu', { get: () => undefined }); });
// per-frame main-thread CPU: wrap rAF callbacks and worker message handlers before any page script runs
await page.evaluateOnNewDocument(() => {
    const P = window.__perf = { acc: 0, sec: {}, on: false };
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf((t) => { const s = performance.now(); try { cb(t); } finally { P.acc += performance.now() - s; } });
    const W = window.Worker;
    window.Worker = class extends W {
        set onmessage(fn) { super.onmessage = (e) => { const s = performance.now(); try { fn(e); } finally { const d = performance.now() - s; P.acc += d; P.sec.workerMsg = (P.sec.workerMsg || 0) + d; } }; }
        get onmessage() { return super.onmessage; }
    };
});
await page.goto(url);
await page.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 90000 });
await new Promise(r => setTimeout(r, 1500));

const client = await page.createCDPSession();
if(cpu) { await client.send('Profiler.enable'); await client.send('Profiler.setSamplingInterval', { interval: 100 }); await client.send('Profiler.start'); }

const res = await page.evaluate(async (seconds, scenario) => {
    const ctx = window.ctx, P = window.__perf, frames = [], longTasks = [];
    // section timers on the live objects (nested sections count in both)
    const wrap = (obj, name, label = name) => {
        if(!obj || typeof obj[name] !== 'function') return;
        const f = obj[name];
        obj[name] = function(...a) { const s = performance.now(); try { return f.apply(this, a); } finally { P.sec[label] = (P.sec[label] || 0) + performance.now() - s; } };
    };
    wrap(ctx.destruction, 'carve');
    wrap(ctx.world, 'applyBrush');
    if(ctx.world.remote) { wrap(ctx.world.remote, '_reply', 'terrainReply'); wrap(ctx.world, 'notify', 'terrainNotify'); }
    wrap(ctx.physics, 'step', 'physics.step');
    wrap(ctx.physics.b3, 'step', 'b3.step');
    wrap(ctx.physics, 'setChunkCollider', 'colliders');
    const vbs = ctx.destruction.bodies;
    wrap(vbs, '_frame', 'bodyJobs');
    wrap(vbs, '_step', 'bodySteps');
    wrap(ctx.terrain, '_apply', 'terrainMesh');
    wrap(ctx.renderer, 'render');
    if(ctx.game) { wrap(ctx.game.player, 'update', 'player'); for(const b of ctx.game.bots) wrap(b, 'update', 'bots'); wrap(ctx.game.fx, 'update', 'fx'); wrap(ctx.game.hud, 'update', 'hud'); wrap(ctx.game.combat, 'update', 'combat'); }
    try { new PerformanceObserver(l => { for(const e of l.getEntries()) longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask' }); } catch {}
    const heap0 = performance.memory?.usedJSHeapSize || 0;
    let heapMax = heap0;
    const t0 = performance.now();
    let last = t0, i = 0;
    const cam = ctx.camera;
    const path = (t) => [-60 + t * 9, 9 + Math.sin(t * 0.7) * 3, Math.sin(t * 0.4) * 12];
    const scen = {};
    let nextBlast = 1.0, nextDig = 1.0, nextBite = 1.0, nextRocket = 1.0, seed = 1;
    const aimHit = (spread) => {
        const v = cam.getWorldDirection(new cam.position.constructor());
        const d = [v.x + Math.sin(seed) * spread, v.y - 0.3, v.z + Math.cos(seed) * spread]; seed++;
        const l = Math.hypot(...d);
        return ctx.world.raycast(cam.position.toArray(), d.map(x => x / l), 60);
    };
    const capsule = ctx.destruction.brushes.capsule;
    P.acc = 0; P.sec = {};
    await new Promise(resolve => {
        const tick = (now) => {
            // the previous frame's totals (this callback runs once per frame)
            let awake = 0; for(const pr of ctx.physics.props) if(!pr.removed && pr.body.isDynamic?.() && !pr.body.isSleeping()) awake++;
            frames.push({ dt: now - last, cpu: P.acc, sec: P.sec, bodies: ctx.physics.props.size, awake, cols: ctx.physics.b3.colliders.size });
            P.acc = 0; P.sec = {};
            last = now;
            const t = (now - t0) / 1000;
            if(scenario === 'topple') { cam.position.set((scen.x || 0) - 4, 6, 22); cam.lookAt(scen.x || 0, 3, 0); }
            else if(scenario !== 'idle' && scenario !== 'game') {
                const p = path(t), q = path(t + 0.5);
                cam.position.set(...p); cam.lookAt(q[0], q[1] - 3, q[2]);
            }
            if(scenario === 'blasts' && t > nextBlast) {
                nextBlast += 0.35;
                const hit = aimHit(0.3);
                if(hit) ctx.destruction.blast(hit.point, 2.4 + (seed % 3));
            }
            if(scenario === 'dig' && t > nextDig) {
                nextDig += 0.125;
                const hit = aimHit(0.15);
                if(hit) { const p = hit.point; ctx.destruction.carve(capsule([p[0], p[1] + 0.5, p[2]], [p[0] + 1.3, p[1] + 0.3, p[2]], 1.6)); }
            }
            if(scenario === 'dig' && t > nextBite) {
                nextBite += 0.5;
                const hit = aimHit(0.2);
                if(hit) ctx.destruction.blast(hit.point, 1.05, { strength: 5 }); // a punch's bite
            }
            if(scenario === 'topple') {
                // a brick bridge (two 7 m pillars and an 18 m deck) built in the middle of the field, then its pillars
                // are cut 4.5 m high: the deck falls, hits the ground at ~16 m/s and fractures
                const B = (min, max) => ctx.destruction.brushes.box(min, max);
                const y0 = 0.1, X = (scen.x ??= 0);
                if(i === 5) {
                    for(const x of [-7.5, 7.5]) ctx.destruction.carve(B([X + x - 1, y0 - 0.5, -1], [X + x + 1, y0 + 7, 1]), { op: 'add', mat: 5 });
                    ctx.destruction.carve(B([X - 9, y0 + 7, -1.5], [X + 9, y0 + 8.2, 1.5]), { op: 'add', mat: 5 });
                }
                if(i > 5 && !scen.cut && ctx.terrain.pending === 0 && t > 2) {
                    scen.cut = true;
                    for(const x of [-7.5, 7.5]) ctx.destruction.carve(B([X + x - 1.5, y0 + 0.6, -1.5], [X + x + 1.5, y0 + 5.1, 1.5]), { hardness: false });
                }
                if(scen.cut && !scen.again && t > 6) { scen.again = true; scen.cut = false; scen.x = 30; i = 4; } // a second bridge elsewhere
            }
            if(scenario === 'game' && ctx.game) {
                const g = ctx.game, pl = g.player;
                if(!g.started) { g.started = true; g.emit('start', {}); }
                if(pl.alive) {
                    if(t > nextRocket) {
                        nextRocket += 0.9;
                        // at the enemy fort, sweeping
                        pl.yaw = (pl.spawn[0] < 0 ? -Math.PI / 2 : Math.PI / 2) + Math.sin(t * 0.7) * 0.5;
                        pl.pitch = -0.05 + Math.sin(t * 1.3) * 0.1;
                        g.combat.fireRocket(pl, pl.arsenal?.muzzle ? pl.arsenal.muzzle() : pl.eye(), pl.aimDir());
                    }
                    if(t > nextDig) { nextDig += 0.36; const d = pl.aimDir(); g.combat.dig(pl, [d[0], -0.4, d[2]].map((x, _, a) => x / Math.hypot(...a))); }
                }
            }
            if(i % 30 === 0) heapMax = Math.max(heapMax, performance.memory?.usedJSHeapSize || 0);
            i++;
            if(t < seconds) requestAnimationFrame(tick); else resolve();
        };
        requestAnimationFrame(tick);
    });
    const heap1 = performance.memory?.usedJSHeapSize || 0;
    return { frames, longTasks, bodies: ctx.physics.props.size, heap0, heap1, heapMax, backend: ctx.renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2', stats: { ...ctx.destruction.bodies.stats, terrainWorker: ctx.world.remote?.stats } };
}, seconds, scenario);

if(cpu) {
    const { profile } = await client.send('Profiler.stop');
    const self = new Map();
    const byId = new Map(profile.nodes.map(n => [n.id, n]));
    const parent = new Map();
    for(const n of profile.nodes) for(const c of n.children || []) parent.set(c, n.id);
    const dt = new Map();
    for(let k = 0; k < profile.samples.length; k++) dt.set(profile.samples[k], (dt.get(profile.samples[k]) || 0) + (profile.timeDeltas[k] || 0));
    const keyOf = (n) => { const f = n.callFrame; return `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`; };
    for(const [id, us] of dt) { const k = keyOf(byId.get(id)); self.set(k, (self.get(k) || 0) + us); }
    const total = [...self.values()].reduce((a, b) => a + b, 0);
    console.log('\nTop self time:');
    for(const [k, us] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`${(us / 1000).toFixed(0).padStart(7)} ms ${(us / total * 100).toFixed(1).padStart(5)}%  ${k}`);
    const who = flag('--who');
    if(who) {
        const callers = new Map();
        for(const [id, us] of dt) {
            // the stack of each sample: attribute to the chain above the first frame named `who`
            let n = id, chain = [];
            while(n != null) { chain.push(byId.get(n)); n = parent.get(n); }
            const at = chain.findIndex(x => x.callFrame.functionName === who);
            if(at < 0) continue;
            const k = chain.slice(at + 1, at + 1 + (+flag("--depth", 5))).map(x => x.callFrame.functionName || '(anon)').join(' < ');
            callers.set(k, (callers.get(k) || 0) + us);
        }
        console.log(`\nCallers of ${who}:`);
        for(const [k, us] of [...callers].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`${(us / 1000).toFixed(1).padStart(7)} ms  ${k}`);
    }
    const under = flag('--under'); // NAME or NAME@LINE (bundle line): self time of everything called below it
    if(under) {
        const [nm, ln] = under.split('@');
        const agg = new Map();
        let tot = 0;
        for(const [id, us] of dt) {
            let n = id, hit = false;
            while(n != null) { const f = byId.get(n).callFrame; if(f.functionName === nm && (!ln || f.lineNumber + 1 === +ln)) { hit = true; break; } n = parent.get(n); }
            if(!hit) continue;
            // --js: attribute to the nearest JavaScript caller with a name (wasm and engine frames skipped)
            let m = id;
            if(args.includes('--js')) while(m != null && !(byId.get(m).callFrame.url.endsWith('main.js') && byId.get(m).callFrame.functionName)) m = parent.get(m);
            const k = keyOf(byId.get(m ?? id));
            agg.set(k, (agg.get(k) || 0) + us); tot += us;
        }
        console.log(`\nUnder ${under} (${(tot / 1000).toFixed(0)} ms total):`);
        for(const [k, us] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`${(us / 1000).toFixed(1).padStart(7)} ms  ${k}`);
    }
    if(flag('--trace')) fs.writeFileSync(flag('--trace'), JSON.stringify(profile));
}

const F = res.frames.slice(5);
const stat = (xs) => {
    const f = [...xs].sort((a, b) => a - b), q = (p) => f[Math.min(f.length - 1, Math.floor(f.length * p))];
    return { p50: q(0.5), p99: q(0.99), p999: q(0.999), max: f[f.length - 1], mean: f.reduce((a, b) => a + b, 0) / f.length };
};
const fmt = (s) => `p50 ${s.p50.toFixed(2)}  p99 ${s.p99.toFixed(2)}  p99.9 ${s.p999.toFixed(2)}  max ${s.max.toFixed(2)} ms`;
const dts = stat(F.map(f => f.dt)), cpus = stat(F.map(f => f.cpu));
console.log(`\n${scenario} (${res.backend}): ${F.length} frames in ${seconds} s, ${(1000 / dts.mean).toFixed(0)} fps mean`);
console.log(`  frame interval  ${fmt(dts)}`);
console.log(`  main-thread CPU ${fmt(cpus)}`);
console.log(`  CPU frames > 3 ms: ${F.filter(f => f.cpu > 3).length}, > 4.17 ms: ${F.filter(f => f.cpu > 4.17).length}, > 8.3 ms: ${F.filter(f => f.cpu > 8.3).length}`);
const labels = [...new Set(F.flatMap(f => Object.keys(f.sec)))];
console.log('  sections (per frame, ms):');
for(const l of labels.sort()) { const s = stat(F.map(f => f.sec[l] || 0)); console.log(`    ${l.padEnd(14)} mean ${s.mean.toFixed(3)}  p99 ${s.p99.toFixed(2)}  max ${s.max.toFixed(2)}`); }
console.log('  worst CPU frames:');
for(const f of [...F].sort((a, b) => b.cpu - a.cpu).slice(0, 8)) console.log(`    ${f.cpu.toFixed(2)} ms  [bodies ${f.bodies}, awake ${f.awake}, colliders ${f.cols}]  ` + Object.entries(f.sec).filter(([, v]) => v > 0.3).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', '));
console.log(`  JS heap ${(res.heap0 / 1e6).toFixed(0)} -> ${(res.heap1 / 1e6).toFixed(0)} MB (max ${(res.heapMax / 1e6).toFixed(0)}); bodies at end ${res.bodies}; long tasks ${JSON.stringify(res.longTasks.slice(0, 10))}`);
console.log(`  body stats ${JSON.stringify(res.stats, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v)}`);
{
    // errors grouped by message with numbers stripped (e.g. buffer sizes), first few shown
    const g = new Map();
    for(const [m, n] of errors) { const k = m.replace(/\d+/g, '#').slice(0, 200); g.set(k, (g.get(k) || 0) + n); }
    for(const [m, n] of [...g].slice(0, 5)) console.log(`  [error x${n}] ${m}`);
}
if(flag('--json')) fs.writeFileSync(flag('--json'), JSON.stringify({ scenario, dt: dts, cpu: cpus }));
await browser.close();
