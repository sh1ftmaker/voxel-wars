/** Ground riders (src/soft/GroundRider.js): chunks and a crate resting on grass while the soft ground heaves under
 *  them. Measures, every frame of the wobble, how far each body's drawn pose is from riding the ground: the gap between
 *  its drawn vertical offset (mesh vs physics pose) and the ground's displacement under it. With ?ride=0 (the old
 *  behaviour) the gap is the whole heave. Screenshots of the sequence.
 *  node tools/test/softride.mjs [outDir] [--url http://127.0.0.1:5200/] [--blast] [--off]   (dev server running) */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : null;
const base = val('--url', 'http://127.0.0.1:5200/');
const many = args.includes('--many'), off = args.includes('--off'), blast = args.includes('--blast'), fly = args.includes('--fly');
if(out) fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--ignore-gpu-blocklist', '--use-angle=vulkan'] });
const page = await browser.newPage();
await page.setViewport({ width: 960, height: 540 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); });
await page.goto(`${base}?fly=${fly ? 1 : 0}&bots=0&music=0${off ? '&ride=0' : ''}`);
await page.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 90000 });
const X = -14, Z = 14;
const setup = await page.evaluate(async (X, Z, many) => {
    const d = ctx.destruction, B = d.brushes, w = (ms) => new Promise(r => setTimeout(r, ms));
    d.bodies.stamp = () => {}; // keep them bodies for the test
    const W = ctx.world;
    let gy = 10; while(gy > -10 && W.sample(X, gy, Z) > 0) gy -= 0.05;
    // three slabs in the air (each its own island: they fall onto the grass) and a crate
    const slabs = many ? Array.from({ length: 20 }, (_, i) => [((i % 5) - 2) * 1.9, Math.floor(i / 5) * 1.6 - 2.4, i % 3]) : [[-2.5, 0, 0], [0.5, -1.5, 5], [2, 2, 1]];
    for(const [dx, dz, m] of slabs) d.carve(B.box([X + dx - (many ? 0.7 : 0.9), gy - 0.3, Z + dz - 0.6], [X + dx + (many ? 0.7 : 0.9), gy + 1.4, Z + dz + 0.6]), { op: 'add', mat: m });
    await w(800);
    for(const [dx, dz] of slabs) d.carve(B.box([X + dx - 1.2, gy + 0.1, Z + dz - 0.9], [X + dx + 1.2, gy + 0.6, Z + dz + 0.9]), { hardness: false });
    const cr = ctx.game?.crates.list[0];
    if(cr) cr.prop.body.setTranslation({ x: X - 0.5, y: gy + 1.2, z: Z + 3 }, true); if(cr) cr.prop.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    const pl = ctx.game?.player; if(pl) { pl.body.teleport([X, gy + 0.3, Z + 10]); pl.yaw = 0; pl.pitch = -0.2; }
    for(const el of document.querySelectorAll('body > div')) el.style.display = 'none';
    if(pl) pl.updateCamera = () => { const c = ctx.camera; c.position.set(X + 0.5, gy + 1.7, Z + 6); c.lookAt(X, gy + 0.2, Z); if(pl.viewModel?.root) pl.viewModel.root.visible = false; };
    await w(2500);
    return { gy, bodies: ctx.physics.props.size, soft: ctx.soft.label };
}, X, Z, many);
console.log('setup', JSON.stringify(setup));
const cam = async () => page.evaluate((X, Z, gy) => { const c = ctx.camera; c.position.set(X + 0.5, gy + 1.7, Z + 6); c.lookAt(X, gy + 0.2, Z); }, X, Z, setup.gy);
await page.evaluate((X, Z, gy, blast) => {
    window.__ride = { max: 0, sum: 0, n: 0, maxU: 0, frames: 0, sunk: 0, float: 0 };
    const sim = ctx.soft.sim, R = window.__ride, u = [0, 0, 0], VOX = 0.25;
    const M4 = ctx.camera.matrix.constructor, V3 = ctx.camera.position.constructor;
    const phys = new M4(), D = new M4(), inv = new M4(), one = new V3(1, 1, 1), pos = new V3(), q = ctx.camera.quaternion.clone(), v = new V3();
    const tick = () => {
        R.frames++;
        for(const p of ctx.physics.props) {
            if(!p.mesh || p.userData?.held) continue;
            const t = p.body.translation(), r = p.body.rotation();
            if(Math.hypot(t.x - X, t.z - Z) > 6) continue;
            // body-local box: a voxel body's grid, else its mesh's geometry
            const vb = p.userData?.voxelBody;
            let lo, hi;
            if(vb) { const g = vb.grid, f = vb.frame; lo = [-VOX - f[0], -VOX - f[1], -VOX - f[2]]; hi = [g.nx * VOX - f[0], g.ny * VOX - f[1], g.nz * VOX - f[2]]; }
            else { const geo = p.mesh.geometry || p.mesh.children.find(c => c.geometry)?.geometry; if(!geo) continue; geo.boundingBox || geo.computeBoundingBox(); lo = geo.boundingBox.min.toArray(); hi = geo.boundingBox.max.toArray(); }
            phys.compose(pos.set(t.x, t.y, t.z), q.set(r.x, r.y, r.z, r.w), one);
            p.mesh.updateMatrix();
            D.multiplyMatrices(p.mesh.matrix, inv.copy(phys).invert()); // physics pose -> drawn pose
            // the bottom corners and middle of its physics AABB: the ground there, and where they are drawn
            const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
            for(let k = 0; k < 8; k++) { v.set(k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]).applyMatrix4(phys); for(let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], v.getComponent(a)); mx[a] = Math.max(mx[a], v.getComponent(a)); } }
            let gap = Infinity, heave = 0;
            for(const [fx, fz] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75], [0.5, 0.5]]) {
                const px = mn[0] + (mx[0] - mn[0]) * fx, pz = mn[2] + (mx[2] - mn[2]) * fz, py = mn[1];
                if(ctx.world.sample(px, py, pz) > 0.2) continue; // no ground right under this one
                sim.sample(px, py - 0.05, pz, 0, u);
                v.set(px, py, pz).applyMatrix4(D);
                gap = Math.min(gap, v.y - (py + u[1])); // drawn underside above the deformed ground (0: resting on it)
                heave = Math.max(heave, Math.abs(u[1]));
            }
            if(gap === Infinity) continue;
            R.maxU = Math.max(R.maxU, heave);
            if(heave > 0.02) { const e = Math.abs(gap); R.max = Math.max(R.max, e); R.sum += e; R.n++; R.sunk = Math.min(R.sunk, gap); R.float = Math.max(R.float, gap); }
        }
        if(R.on) requestAnimationFrame(tick);
    };
    R.on = true; requestAnimationFrame(tick);
    if(blast) ctx.destruction.blast([X + 5, gy + 0.2, Z - 3], 1.4, { strength: 14 });
    else ctx.soft.wake([X, gy - 0.2, Z], { speed: 12, radius: 4.5, up: 0.6 });
}, X, Z, setup.gy, blast);
let last = 0;
for(const t of [0, 120, 250, 400, 600, 900, 1300, 2000]) {
    await new Promise(r => setTimeout(r, t - last)); last = t;
    await cam();
    if(out) await page.screenshot({ path: `${out}/${off ? 'off' : 'on'}${blast ? '-blast' : ''}${fly ? '-fly' : ''}-${t}.png` });
}
await new Promise(r => setTimeout(r, 1500));
const res = await page.evaluate(() => { const R = window.__ride; R.on = false; return { maxGap: +R.max.toFixed(3), worstSunk: +R.sunk.toFixed(3), worstFloat: +R.float.toFixed(3), meanGap: +(R.sum / Math.max(1, R.n)).toFixed(3), maxHeave: +R.maxU.toFixed(3), samples: R.n, frames: R.frames, rider: ctx.soft.rider?.stats, frameMs: ctx.physics.stepMs, softCpu: ctx.soft.stats.cpuMs }; });
console.log(off ? 'ride OFF' : 'ride ON', blast ? '(blast)' : '(wake)', JSON.stringify(res));
console.log(errors.length ? errors : 'no errors');
await browser.close();
if(errors.length) process.exit(1);
