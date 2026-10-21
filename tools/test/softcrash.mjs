/** Crash hunt for soft debris: towers are cut down, then blasts, drills and grabs hit the debris while it wobbles,
 *  cracks and settles (150 hits over ~15 s). Any page error or Rapier panic fails it.
 *  node tools/test/softcrash.mjs [url]   (dev server running) */
import puppeteer from 'puppeteer-core';
const url = process.argv[2] || 'http://127.0.0.1:5180/?fly=1&bots=0&music=0';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--ignore-gpu-blocklist', '--use-angle=vulkan', '--window-size=1280,720'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); });
await page.goto(url);
await page.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 90000 });
const res = await page.evaluate(async () => {
    const d = ctx.destruction, b = d.bodies, B = d.brushes;
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    ctx.camera.position.set(0, 14, 26); ctx.camera.lookAt(10, 2, 0);
    // three columns and a slab in the field
    for(const [x, z, m] of [[8, 4, 0], [12, -3, 5], [16, 5, 1], [20, 0, 10]]) d.carve(B.box([x - 1, -0.4, z - 1], [x + 1, 8, z + 1]), { op: 'add', mat: m });
    await w(1500);
    for(const [x, z] of [[8, 4], [12, -3], [16, 5], [20, 0]]) d.carve(B.box([x - 1.5, 0.6, z - 1.5], [x + 1.5, 1.4, z + 1.5]), { hardness: false });
    await w(200);
    for(const [x, z] of [[8, 4], [12, -3], [16, 5], [20, 0]]) d.blast([x - 1.6, 7, z], 1.1, { strength: 14 });
    let hits = 0, held = null;
    for(let i = 0; i < 150; i++) {
        await w(100);
        const list = [...b.list].filter(v => !v.dead);
        if(!list.length) continue;
        const vb = list[(i * 7) % list.length];
        let p;
        try { const t = vb.body.translation(); p = [t.x, t.y, t.z]; } catch(e) { continue; }
        const k = i % 5;
        if(k === 0 || k === 3) d.blast(p, 1.2 + (i % 3) * 0.5, { strength: 18 });
        else if(k === 1) d.carve(B.capsule([p[0] - 1, p[1], p[2]], [p[0] + 1, p[1], p[2]], 0.5));
        else if(k === 2) vb.explode([p[0] + 1, p[1] - 1, p[2]], 4, 12);
        else if(!held && vb.body.isDynamic()) { held = vb; vb.prop.userData.held = true; setTimeout(() => { if(held) held.prop.userData.held = false; held = null; }, 400); }
        hits++;
    }
    await w(3000);
    // physics alive: a fresh body falls
    const lump = b.rip(B.sphere([-12, 0.3, 12], 1));
    const y0 = lump?.body.translation().y;
    await w(500);
    const y1 = lump && !lump.dead ? lump.body.translation().y : null;
    return { hits, bodies: b.list.size, stats: b.stats, soft: b.soft.stats, physicsAlive: lump ? (y1 === null || y1 !== y0) : 'no lump' };
});
console.log(JSON.stringify(res));
console.log(errors.length ? `FAIL ${errors.length} errors:\n${[...new Set(errors)].slice(0, 10).join('\n')}` : 'PASS no errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
