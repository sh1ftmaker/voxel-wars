/** Stacks of debris settling into the terrain: how far does a piece resting on another move while the one under it
 *  is stamped into the terrain (and while it is stamped itself)? Fracture pieces are dropped onto each other.
 *  node tools/test/stackstamp.mjs [url]   (dev server running) */
import puppeteer from 'puppeteer-core';
const url = process.argv[2] || 'http://127.0.0.1:5180/?fly=1&bots=0&music=0';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--ignore-gpu-blocklist', '--use-angle=vulkan'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); });
await page.goto(url);
await page.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 90000 });
const res = await page.evaluate(async () => {
    const d = ctx.destruction, bodies = d.bodies, B = d.brushes;
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    // towers of slabs: each slab cut free falls onto the one below
    const sites = [[8, 4], [14, -4], [20, 4], [-8, 14]];
    for(const [x, z] of sites) for(let k = 0; k < 3; k++) d.carve(B.box([x - 1.5 + k * 0.3, 0.5 + k * 1.6, z - 1.2], [x + 1.5 + k * 0.3, 1.5 + k * 1.6, z + 1.2]), { op: 'add', mat: k % 2 ? 5 : 0 });
    await w(1500);
    // cut the slabs' gaps so every slab is its own island (they rest on the terrain at 0.5, then on each other)
    for(const [x, z] of sites) d.carve(B.box([x - 3, -0.2, z - 3], [x + 3, 0.55, z + 3]), { hardness: false });
    // track every body: the largest jump per frame while a neighbour or itself is stamping
    const track = new Map(); let worst = 0, worstWhile = 0, frames = 0, stampedN = 0;
    const t0 = performance.now();
    while(performance.now() - t0 < 14000) {
        await new Promise(r => requestAnimationFrame(r)); frames++;
        const anyStamping = [...bodies.list].some(v => v.stamping);
        for(const vb of bodies.list) {
            if(vb.dead || !vb.body.isDynamic()) continue;
            const t = vb.body.translation(), p = track.get(vb);
            if(p && vb.age > 3 && p.still > 0.5) { // was resting: any move now is a shift
                const dd = Math.hypot(t.x - p.x, t.y - p.y, t.z - p.z);
                worst = Math.max(worst, dd); if(anyStamping) worstWhile = Math.max(worstWhile, dd);
            }
            track.set(vb, { x: t.x, y: t.y, z: t.z, still: vb.still });
        }
    }
    return { worst: +worst.toFixed(3), worstWhileStamping: +worstWhile.toFixed(3), stamped: bodies.stats.stamped, left: bodies.list.size, frames };
});
console.log(JSON.stringify(res));
console.log(errors.length ? errors : 'no errors');
await browser.close();
