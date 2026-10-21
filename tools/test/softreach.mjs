/**
 * Soft ground reach, punches, structural collapse and the grab tear, in headless Chromium (WebGL2: the CPU worker
 * solver; --webgpu for the compute path). Screenshots go to <outPrefix>-<scenario>-<ms>.png.
 *   punch   a punch (carve with dir) into the ground and into a fort wall: the zone's max displacement
 *   blast   a rocket-sized blast on the field: the far zone's reach (displacement 6, 9, 12 m out, over time)
 *   wall    a blast at the foot of a fort wall: the wall shudders along its length (displacement 8 m along it)
 *   bridge  the gorge bridge blown out at its west end (three rockets): it comes down (bodies, volume)
 *   grab    the player tears a lump out of the grass (and of a stone wall), then throws it: it stays a body
 * node tools/test/softreach.mjs [outPrefix] [--url http://127.0.0.1:5195/] [--webgpu] [--only a,b] [--tets] [--slowtear]
 */
import puppeteer from 'puppeteer-core';
const args = process.argv.slice(2);
const val = (k, d) => args.includes(k) ? args[args.indexOf(k) + 1] : d;
const out = args.find((a, i) => !a.startsWith('--') && !['--url', '--only'].includes(args[i - 1])) || '/tmp/softreach';
const base = val('--url', 'http://127.0.0.1:5195/');
const webgpu = args.includes('--webgpu');
const only = val('--only', 'punch,blast,wall,bridge,grab').split(',');
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new',
    args: [...(webgpu ? ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU'] : ['--use-angle=vulkan']), '--ignore-gpu-blocklist', '--window-size=960,540'] });
const errors = [];
let fails = 0;
const check = (ok, msg) => { console.log(ok ? '  ok  ' : '  FAIL', msg); if(!ok) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function open(game) {
    const page = await browser.newPage();
    await page.setViewport({ width: 960, height: 540 });
    page.on('console', m => { const t = m.text(); if(m.type() === 'error') { errors.push(t); console.log('[console error]', t.slice(0, 300)); } });
    page.on('pageerror', e => { errors.push(e.message); console.log('[pageerror]', e.message); });
    if(!webgpu) await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'gpu', { get: () => undefined }); });
    await page.goto(`${base}?${game ? '' : 'fly=1&'}bots=0&music=0${args.includes('--tets') ? '&tets=1' : ''}`);
    await page.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 120000 });
    await page.evaluate(() => {
        window.__dts = []; let last = performance.now();
        const tick = (t) => { window.__dts.push(t - last); last = t; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
        // the soft zones' displacement: max |u| per zone, and |u| at given points (nearest node)
        window.__probe = async (points = []) => {
            const s = window.ctx.soft, res = [];
            for(const z of s.zones) {
                if(z.state !== 'sim' && z.state !== 'frozen') continue;
                const nodes = (z.n[0] + 1) * (z.n[1] + 1) * (z.n[2] + 1);
                const u = await s.sim.readSlot(z.slot, nodes);
                let m = 0; for(let i = 0; i < nodes; i++) m = Math.max(m, Math.hypot(u[i * 4], u[i * 4 + 1], u[i * 4 + 2]));
                const at = points.map(p => {
                    // the largest |u| among the nodes within a cell of the point (surface nodes move most)
                    let best = 0;
                    const g = p.map((v, a) => (v - z.c0[a] * z.h) / z.h);
                    for(let k = Math.floor(g[2]) - 1; k <= Math.ceil(g[2]) + 1; k++) for(let j = Math.floor(g[1]) - 2; j <= Math.ceil(g[1]) + 2; j++) for(let i = Math.floor(g[0]) - 1; i <= Math.ceil(g[0]) + 1; i++) {
                        if(i < 0 || j < 0 || k < 0 || i > z.n[0] || j > z.n[1] || k > z.n[2]) continue;
                        const n = i + j * (z.n[0] + 1) + k * (z.n[0] + 1) * (z.n[1] + 1);
                        best = Math.max(best, Math.hypot(u[n * 4], u[n * 4 + 1], u[n * 4 + 2]));
                    }
                    return +best.toFixed(3);
                });
                res.push({ slot: z.slot, h: z.h, n: z.n.join('x'), cells: z.count, state: z.state, maxU: +m.toFixed(3), at });
            }
            return res;
        };
        // CPU path: the peak |u| near given points, read from the deformation texture every frame (screenshots stall
        // the page, so sampling now and then misses a ripple passing by)
        window.__track = (points) => {
            const s = window.ctx.soft, peak = points.map(() => 0);
            window.__peak = peak;
            const tick = () => {
                const data = s.sim?.tex?.image?.data;
                if(data && s.sim.cpu) for(const z of s.zones) {
                    if(z.state !== 'sim') continue;
                    const NX = z.n[0] + 1, NXY = NX * (z.n[1] + 1), base = z.slot * 8192;
                    points.forEach((p, pi) => {
                        const g = p.map((v, a) => (v - z.c0[a] * z.h) / z.h);
                        for(let k = Math.floor(g[2]) - 1; k <= Math.ceil(g[2]) + 1; k++) for(let j = Math.floor(g[1]) - 2; j <= Math.ceil(g[1]) + 2; j++) for(let i = Math.floor(g[0]) - 1; i <= Math.ceil(g[0]) + 1; i++) {
                            if(i < 0 || j < 0 || k < 0 || i > z.n[0] || j > z.n[1] || k > z.n[2]) continue;
                            const o = (base + i + j * NX + k * NXY) * 4;
                            peak[pi] = Math.max(peak[pi], Math.hypot(data[o], data[o + 1], data[o + 2]));
                        }
                    });
                }
                if(window.__peak === peak) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        };
    });
    await sleep(2500);
    return page;
}
const frameStats = (page) => page.evaluate(() => { const d = window.__dts.slice(2).sort((a, b) => a - b); window.__dts.length = 0; return { median: +d[d.length >> 1]?.toFixed(1), p95: +d[Math.floor(d.length * 0.95)]?.toFixed(1), max: +d.at(-1)?.toFixed(1), n: d.length }; });
const softStats = (page) => page.evaluate(() => { const s = window.ctx.soft; return { label: s.label, cpuMax: +s.stats.cpuMax.toFixed(2), worker: s.sim?.stats ? { ms: +s.sim.stats.workerMs.toFixed(2), max: +s.sim.stats.workerMax.toFixed(2), dropped: s.sim.stats.dropped } : null }; });

// ---------------------------------------------------------------- fly-camera scenarios
if(only.some(o => ['punch', 'blast', 'wall', 'bridge'].includes(o))) {
    const page = await open(false);
    const look = (from, at) => page.evaluate((f, a) => { const c = window.ctx.camera; c.position.set(...f); c.lookAt(...a); }, from, at);
    const shoot = (name) => page.screenshot({ path: `${out}-${name}.png` });

    if(only.includes('punch')) {
        // the field east of the gorge: punch straight down into the grass, and into the blue fort's west wall
        for(const [label, origin, dir, cam] of [
            ['punch-ground', [20, 3, -12], [0, -0.6, -0.8], [[24, 3.5, -6], [20, 0, -14]]],
            ['punch-wall', [30, 2.5, -2], [1, 0, 0], [[31, 3, 6], [37, 2.5, -2]]],
        ]) {
            await look(...cam);
            await sleep(500);
            const r = await page.evaluate(async (o, d) => {
                const ctx = window.ctx, l = Math.hypot(...d), dir = d.map(v => v / l);
                const hit = ctx.world.raycast(o, dir, 20);
                if(!hit) return null;
                const p = hit.point, c = p.map((v, a) => v + dir[a] * 0.35);
                const res = ctx.destruction.carve(ctx.destruction.brushes.rock(c, 1.05, 3), { impulse: 5, kind: 'carve', dir });
                await res.done;
                return p;
            }, origin, dir);
            let peak = 0;
            for(const t of [80, 160, 300, 600]) {
                await sleep(t === 80 ? 80 : 120);
                const z = await page.evaluate(() => window.__probe());
                peak = Math.max(peak, ...z.map(q => q.maxU), 0);
                if(t === 160) await shoot(label);
                console.log(`${label} t~${t}`, JSON.stringify(z));
            }
            check(r && peak > 0.12, `${label}: the punch wobbles the ground (peak |u| ${peak.toFixed(2)} m)`);
            await sleep(3500);
        }
    }

    if(only.includes('blast')) {
        const p = await page.evaluate(() => window.ctx.world.raycast([22, 30, -14], [0, -1, 0], 60).point);
        await look([p[0] + 2, p[1] + 9, p[2] + 22], [p[0], p[1], p[2] - 2]);
        await sleep(600);
        await shoot('blast-0');
        const pts = [6, 9, 12].map(d => [p[0] + d, p[1], p[2]]);
        await page.evaluate((p, pts) => { window.__track(pts); window.ctx.destruction.blast(p, 2.4, { strength: 16 }); }, p, pts);
        const reach = [0, 0, 0];
        const t0 = Date.now();
        for(const t of [120, 220, 330, 450, 600, 800, 1100, 1600]) {
            const w = t - (Date.now() - t0); if(w > 0) await sleep(w);
            if([220, 450].includes(t)) await shoot(`blast-${t}`);
            const z = await page.evaluate((pts) => window.__probe(pts), pts);
            for(const q of z) if(q.h > 0.6) q.at.forEach((v, i) => reach[i] = Math.max(reach[i], v));
            console.log(`blast t=${t}`, JSON.stringify(z));
        }
        const tracked = await page.evaluate(() => { const p = window.__peak.map(v => +v.toFixed(3)); window.__peak = null; return p; });
        if(!webgpu) tracked.forEach((v, i) => reach[i] = Math.max(reach[i], v));
        console.log('blast reach |u| at 6, 9, 12 m:', reach, JSON.stringify(await softStats(page)), JSON.stringify(await frameStats(page)));
        check(reach[1] > 0.05, `a blast moves the ground 9 m away (${reach[1]} m)`);
        await sleep(3500);
    }

    if(only.includes('wall')) {
        // the blue fort's west wall (x 36..38.5, z -13..13): a blast at its foot, outside
        const p = await page.evaluate(() => window.ctx.world.raycast([30, 1, 4], [1, 0, 0], 20).point);
        await look([p[0] - 14, 4, p[2] + 14], [p[0], 3, p[2] - 4]);
        await sleep(600);
        await shoot('wall-0');
        const along = [[p[0] + 1, 3, p[2] - 8], [p[0] + 1, 5, p[2] - 4], [p[0] + 1, 5, p[2]]];
        await page.evaluate((p, pts) => { window.__track(pts); window.ctx.destruction.blast([p[0] - 1.2, 0.6, p[2]], 2.4, { strength: 16 }); }, p, along);
        const reach = [0, 0, 0];
        const t0 = Date.now();
        for(const t of [150, 300, 500, 800, 1200]) {
            const w = t - (Date.now() - t0); if(w > 0) await sleep(w);
            if([150, 300].includes(t)) await shoot(`wall-${t}`);
            const z = await page.evaluate((pts) => window.__probe(pts), along);
            for(const q of z) q.at.forEach((v, i) => reach[i] = Math.max(reach[i], v));
            console.log(`wall t=${t}`, JSON.stringify(z));
        }
        const tracked = await page.evaluate(() => { const p = window.__peak.map(v => +v.toFixed(3)); window.__peak = null; return p; });
        if(!webgpu) tracked.forEach((v, i) => reach[i] = Math.max(reach[i], v));
        console.log('wall |u| 8 m along, 4 m along up high, at the blast up high:', reach);
        check(reach[0] > 0.03, `the wall shudders 8 m along from the blast (${reach[0]} m)`);
        await sleep(3500);
    }

    if(only.includes('bridge')) {
        await look([-16, 6, -16], [-2, -1, 0]);
        await sleep(800);
        await shoot('bridge-0');
        const before = await page.evaluate(() => window.ctx.destruction.bodies.list.size);
        for(const z of [-3.2, 0, 3.2]) {
            await page.evaluate((z) => window.ctx.destruction.blast([-7.6, -0.5, z], 2.4, { strength: 16 }), z); // rockets
            await sleep(150);
        }
        const t0 = Date.now();
        let vol = 0, n = 0;
        for(const t of [300, 700, 1200, 2000, 3000]) {
            const w = t - (Date.now() - t0); if(w > 0) await sleep(w);
            await shoot(`bridge-${t}`);
            const s = await page.evaluate(() => { const b = window.ctx.destruction.bodies; let v = 0, big = 0; for(const vb of b.list) { v += vb.volume; big = Math.max(big, vb.volume); } return { n: b.list.size, v: +v.toFixed(1), big: +big.toFixed(1), detached: b.stats.detached }; });
            vol = Math.max(vol, s.big); n = Math.max(n, s.n);
            console.log(`bridge t=${t}`, JSON.stringify(s));
        }
        console.log('bridge frames', JSON.stringify(await frameStats(page)));
        check(vol > 60, `the bridge comes down as a body when its west end is blown out (largest ${vol} m³, ${n} bodies, ${before} before)`);
    }
    await page.close();
}

// ---------------------------------------------------------------- the player's grab
if(only.includes('grab')) {
    const page = await open(true);
    await page.evaluate(() => { for(const e of document.querySelectorAll('.bz-play, .bz-screen')) e.style.display = 'none'; });
    for(const [label, feet, yaw, pitch] of [['grab-grass', [20, 0.2, -10], 0, -0.75], ['grab-wall', [33.4, 0.2, 6], -Math.PI / 2, -0.15]]) {
        await page.evaluate((feet, yaw, pitch) => {
            const pl = window.ctx.game.player;
            pl.body.teleport(feet); pl.yaw = yaw; pl.pitch = pitch;
        }, feet, yaw, pitch);
        await sleep(1200);
        await page.evaluate((pitch) => { window.ctx.game.player.pitch = pitch; }, pitch);
        await page.screenshot({ path: `${out}-${label}-0.png` });
        // (--slowtear: hold on for a second, so the screenshots, which stall the page, catch the stretch)
        const r = await page.evaluate((slow) => { const a = window.ctx.game.player.arsenal; a.cool.grab = 0; a.grab('grab'); const dur = a.tearing?.dur; if(slow && a.tearing) a.tearing.dur = 1; return { tearing: !!a.tearing, dur, mat: a.tearing?.mat, held: !!a.held }; }, args.includes('--slowtear'));
        console.log(label, 'start', JSON.stringify(r));
        const t0 = Date.now();
        let peak = 0, heldAt = -1;
        for(const t of args.includes('--slowtear') ? [150, 350, 600, 900, 1150, 1400] : [60, 140, 220, 320, 450, 650]) {
            const w = t - (Date.now() - t0); if(w > 0) await sleep(w);
            await page.screenshot({ path: `${out}-${label}-${t}.png` });
            const s = await page.evaluate(async () => { const a = window.ctx.game.player.arsenal; const z = await window.__probe(); return { tearing: !!a.tearing, held: !!a.held, maxU: Math.max(0, ...z.map(q => q.maxU)) }; });
            if(s.held && heldAt < 0) heldAt = t;
            if(s.tearing || heldAt === t) peak = Math.max(peak, s.maxU);
            console.log(`${label} t=${t}`, JSON.stringify(s));
        }
        check(peak > 0.15, `${label}: the ground stretches before it tears (peak |u| ${peak.toFixed(2)} m)`);
        check(heldAt > 0, `${label}: the lump comes out and is held (by ${heldAt} ms)`);
        // throw it at the ground ahead: it must stay a body (or crack into bodies), not burst
        const thrown = await page.evaluate(() => {
            const pl = window.ctx.game.player, a = pl.arsenal, prop = pl.held;
            pl.pitch = -0.35;
            a.release(true);
            window.__thrown = prop;
            return !!prop;
        });
        await sleep(150);
        await page.screenshot({ path: `${out}-${label}-throw-150.png` });
        await sleep(1200);
        await page.screenshot({ path: `${out}-${label}-throw-1350.png` });
        const after = await page.evaluate(() => { const b = window.ctx.destruction.bodies; const p = window.__thrown; return { alive: window.ctx.physics.props.has(p), bodies: b.list.size, cracked: b.stats.cracked || 0, fractured: b.stats.fractured, pulverized: +b.stats.pulverized.toFixed(2) }; });
        console.log(label, 'after throw', JSON.stringify(after));
        check(thrown && (after.alive || after.cracked > 0) && after.bodies > 0, `${label}: the thrown lump is still a physics body (or cracked into bodies)`);
        await sleep(2500);
    }
    console.log('grab frames', JSON.stringify(await frameStats(page)), JSON.stringify(await softStats(page)));
    await page.close();
}

console.log('errors', errors.length, errors.slice(0, 5));
check(errors.length === 0, 'no console errors');
await browser.close();
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
