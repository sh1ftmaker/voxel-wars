/** Materials showcase: a row of test blocks of every material (wood beams along each grain axis, a glass pane in a
 *  stone frame), screenshots before and after blasting / punching each, carved volume per material, and frame times.
 *  node tools/test/materials.mjs [outDir] [--url http://127.0.0.1:5180/]   (dev server running) */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : 'shots/materials';
const base = val('--url', 'http://127.0.0.1:5180/');
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--ignore-gpu-blocklist', '--use-angle=vulkan'] });
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 620 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); });
await page.goto(`${base}?fly=1&bots=0&music=0`);
await page.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 90000 });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });

// blocks along x at z = 2, standing on the field (ground ~0.5 m); [label, mat, min, max]
const blocks = await page.evaluate(async () => {
    const d = ctx.destruction, B = d.brushes;
    const list = [];
    let x = 2;
    // walls 2.6 m wide, 3 m high, 1.4 m thick, set 1 m into the ground so a blast bites instead of knocking them over
    const add = (label, mat) => { list.push([label, mat, [x, -0.7, 1.3], [x + 2.6, 2.6, 2.7]]); x += 3.6; };
    add('stone', 0); add('brick', 5); add('cobble', 11); add('darkrock', 12); add('metal', 6);
    add('woodX', 10); add('woodY', 14); add('woodZ', 15);
    for(const [, mat, min, max] of list) d.carve(B.box(min, max), { op: 'add', mat });
    // soils: blast the field itself
    for(const [label, mat] of [['dirt', 1], ['sand', 3], ['snow', 4]]) { list.push([label, mat, [x, -0.7, 0], [x + 3, 0.45, 4]]); d.carve(B.box([x, -0.7, 0], [x + 3, 0.45, 4]), { op: 'paint', mat }); x += 4; }
    // glass pane in a stone frame
    d.carve(B.box([x, -0.7, 1.7], [x + 3.2, 3.2, 2.3]), { op: 'add', mat: 0 });
    d.carve(B.box([x + 0.5, 0.8, 1.6], [x + 2.7, 2.7, 2.4]), { hardness: false });
    d.carve(B.box([x + 0.5, 0.8, 1.9], [x + 2.7, 2.7, 2.1]), { op: 'add', mat: 16 });
    list.push(['glass', 16, [x + 0.5, 0.8, 1.9], [x + 2.7, 2.7, 2.1]]);
    await new Promise(r => setTimeout(r, 2500));
    return list;
});
const view = async (cx, dist = 7) => page.evaluate((cx, dist) => { ctx.camera.position.set(cx, 2.4, 2 + dist); ctx.camera.lookAt(cx, 1.3, 2); }, cx, dist);
const xs = blocks.map(b => (b[2][0] + b[3][0]) / 2);
const midAll = (Math.min(...blocks.map(b => b[2][0])) + Math.max(...blocks.map(b => b[3][0]))) / 2;
await page.evaluate((cx) => { ctx.camera.position.set(cx, 9, 26); ctx.camera.lookAt(cx, 1, 2); }, midAll);
await wait(600);
await shot('all-before');
// close-ups of the wood grains and glass
await view(xs[blocks.findIndex(b => b[0] === 'woodY')], 9); await wait(400); await shot('wood-before');
await view(xs[blocks.findIndex(b => b[0] === 'glass')], 5); await wait(400); await shot('glass-before');
// hit each: a blast on the front face (punch-sized for the small ones)
const results = [];
for(const [label, mat, min, max] of blocks) {
    const soil = ['dirt', 'sand', 'snow'].includes(label);
    const cx = (min[0] + max[0]) / 2, cy = soil ? 0.5 : 1.3;
    const r = await page.evaluate(async (p, label) => {
        const d = ctx.destruction;
        const chips = [];
        const on = (e) => chips.push(e.detail);
        ctx.events.addEventListener('chips', on);
        const res = d.blast(p, label === 'glass' ? 0.45 : 1.1, { strength: 4 });
        const done = await res.done;
        await new Promise(r => setTimeout(r, 120));
        ctx.events.removeEventListener('chips', on);
        let byMat = {};
        for(let i = 0; i < 32; i++) if(done.removed[i] > 0) byMat[i] = +done.removed[i].toFixed(3);
        return { volume: +done.volume.toFixed(3), byMat, chips: chips.map(c => c.count) };
    }, [label === 'glass' ? cx - 0.5 : cx, label === 'glass' ? 1.8 : cy, soil ? 2 : max[2] + 0.2], label);
    results.push({ label, mat, ...r });
}
await wait(500);
await page.evaluate((cx) => { ctx.camera.position.set(cx, 9, 26); ctx.camera.lookAt(cx, 1, 2); }, midAll);
await wait(500);
await shot('all-after');
for(const name of ['stone', 'brick', 'cobble', 'woodX', 'woodY', 'woodZ', 'metal', 'dirt', 'sand', 'glass']) {
    const i = blocks.findIndex(b => b[0] === name);
    await view(xs[i], name === 'glass' ? 4 : 5); await wait(350); await shot(`${name}-after`);
}
// a glass lump torn out of the pane: glass on a body (its own draw group)
const lump = await page.evaluate(async (p) => {
    const prop = ctx.destruction.rip(p, 0.85);
    await new Promise(r => setTimeout(r, 600));
    const vb = prop?.userData?.voxelBody;
    return vb ? { mat: vb.mat, volume: +vb.volume.toFixed(3), groups: vb.mesh?.geometry.groups.length ?? -1, materials: Array.isArray(vb.mesh?.material) ? vb.mesh.material.length : 1 } : null;
}, [xs[blocks.findIndex(b => b[0] === 'glass')] + 0.6, 1.4, 2]);
console.log('glass lump', JSON.stringify(lump));
await view(xs[blocks.findIndex(b => b[0] === 'glass')], 4); await wait(300); await shot('glass-lump');
// frame times with fresh marks live
const frames = await page.evaluate(async () => {
    const t = []; let last = performance.now();
    for(let i = 0; i < 120; i++) { await new Promise(r => requestAnimationFrame(r)); const n = performance.now(); t.push(n - last); last = n; }
    t.sort((a, b) => a - b);
    return { median: +t[60].toFixed(1), p95: +t[114].toFixed(1), max: +t[119].toFixed(1), drawCalls: ctx.renderer.info.render.drawCalls ?? ctx.renderer.info.render.calls };
});
console.log(JSON.stringify(results, null, 0).replace(/\},\{/g, '},\n{'));
console.log('frames', JSON.stringify(frames));
console.log(errors.length ? errors.slice(0, 5) : 'no errors');
await browser.close();
