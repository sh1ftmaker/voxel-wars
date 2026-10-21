/** Fracture modes in the game (headless Chromium, WebGL2): a wood beam, a stone column, a metal girder and a dirt lump
 *  are built in the field, cut free so they fall, and blasted; the test counts the 'fracture' / 'splinters' / 'crumble'
 *  / 'bend' events by mode, checks the metal stays whole (bent, baked) and chips come and go, and reports costs.
 *  node tools/test/fracgame.mjs [url] [shotDir]   (dev server running) */
import puppeteer from 'puppeteer-core';
const url = process.argv[2] || 'http://127.0.0.1:5207/?fly=1&bots=0&music=0';
const shots = process.argv[3] || null;
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--ignore-gpu-blocklist', '--use-angle=vulkan', '--window-size=1280,720'] });
const page = await browser.newPage();
await page.setViewport({ width: 960, height: 540 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); });
await page.goto(url);
await page.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 90000 });
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if(!ok) fails++; };

await page.evaluate(() => {
    const ev = window.__ev = [];
    for(const t of ['fracture', 'splinters', 'crumble', 'bend', 'destroyed']) ctx.events.addEventListener(t, (e) => ev.push({ t, mode: e.detail.mode, mat: e.detail.mat, pieces: e.detail.pieces, count: e.detail.count, amount: e.detail.amount, kind: e.detail.kind }));
});
const scene = async (name, setup, waitMs, shotAt = []) => {
    await page.evaluate(() => { window.__ev.length = 0; window.__t0 = performance.now(); });
    await page.evaluate(setup);
    const t0 = Date.now();
    for(const at of shotAt) {
        const w = at - (Date.now() - t0);
        if(w > 0) await new Promise(r => setTimeout(r, w));
        if(shots) await page.screenshot({ path: `${shots}/${name}-${String(at).padStart(4, '0')}.png` });
    }
    const rest = waitMs - (Date.now() - t0);
    if(rest > 0) await new Promise(r => setTimeout(r, rest));
    return page.evaluate(() => {
        const b = ctx.destruction.bodies;
        const by = {};
        for(const e of window.__ev) { const k = e.t + (e.mode ? ':' + e.mode : ''); by[k] = (by[k] || 0) + 1; }
        return { by, ev: window.__ev.filter(e => e.t !== 'destroyed').slice(0, 12), stats: { ...b.stats }, soft: { ...b.soft.stats }, bodies: [...b.list].filter(v => !v.dead).map(v => ({ mat: v.mat, vol: +v.volume.toFixed(2), gen: v.generation, chip: !!v.prop.userData.chip })) };
    });
};
const W = (fn) => `(${fn})()`;

// wood: a beam on two posts; cut the posts, then a rocket on it as it lands
const wood = await scene('wood', W(async () => {
    const d = ctx.destruction, B = d.brushes, w = (ms) => new Promise(r => setTimeout(r, ms));
    ctx.camera.position.set(10, 7, 20); ctx.camera.lookAt(10, 3, 4);
    d.carve(B.box([4, 0, 3.5], [5, 4, 4.5]), { op: 'add', mat: 0 }); d.carve(B.box([15, 0, 3.5], [16, 4, 4.5]), { op: 'add', mat: 0 });
    d.carve(B.box([3, 4, 3.4], [17, 4.75, 4.6]), { op: 'add', mat: 10 });
    await w(1500);
    d.carve(B.box([3.5, 2.2, 3], [5.5, 3.6, 5]), { hardness: false }); d.carve(B.box([14.5, 2.2, 3], [16.5, 3.6, 5]), { hardness: false });
    await w(1100);
    const vb = [...d.bodies.list].find(v => v.mat === 10 && !v.dead);
    if(vb) { const t = vb.body.translation(); d.blast([t.x, t.y + 1.2, t.z], 1.0, { strength: 22 }); }
}), 6000, [1500, 1800, 2400, 3200]);
console.log('wood', JSON.stringify(wood.by), JSON.stringify(wood.ev.slice(0, 4)));
check((wood.by['fracture:splinter'] || 0) >= 1 && (wood.by.splinters || 0) >= 1, `wood splinters (${wood.by['fracture:splinter'] || 0} breaks, ${wood.by.splinters || 0} splinter bursts)`);

// stone: a column cut at its base and blasted over
const stone = await scene('stone', W(async () => {
    const d = ctx.destruction, B = d.brushes, w = (ms) => new Promise(r => setTimeout(r, ms));
    ctx.camera.position.set(-4, 7, 16); ctx.camera.lookAt(-8, 3, 0);
    d.carve(B.box([-9.5, 0, -1.5], [-6.5, 9, 1.5]), { op: 'add', mat: 0 });
    await w(1500);
    d.carve(B.box([-10, 0.6, -2], [-6, 1.4, 2]), { hardness: false });
    await w(200);
    d.blast([-10.2, 7.5, 0], 1.0, { strength: 18 });
}), 6000, [1900, 2600, 3400]);
console.log('stone', JSON.stringify(stone.by), JSON.stringify(stone.ev.slice(0, 3)));
const sf = stone.ev.filter(e => e.t === 'fracture' && e.mode === 'shatter');
check(sf.length >= 1 && sf.some(e => e.pieces >= 3), `stone shatters (${sf.map(e => e.pieces).join(', ')} pieces)`);

// metal: a girder dropped from a height
const metal = await scene('metal', W(async () => {
    const d = ctx.destruction, B = d.brushes, w = (ms) => new Promise(r => setTimeout(r, ms));
    ctx.camera.position.set(22, 6, 16); ctx.camera.lookAt(22, 2, 0);
    d.carve(B.box([21.6, 0, -0.4], [22.4, 9, 0.4]), { op: 'add', mat: 0 });
    d.carve(B.box([17, 9, -0.6], [27, 10, 0.6]), { op: 'add', mat: 6 });
    await w(1500);
    d.carve(B.box([21, 1, -1], [23, 8.5, 1]), { hardness: false });
    // once it lies on the ground: hammer one end down (a series of hard hits there)
    let vb = null;
    for(let i = 0; i < 100 && !(vb && vb.age > 1.2); i++) { await w(50); vb = [...d.bodies.list].find(v => v.mat === 6 && !v.dead); }
    if(vb) for(let k = 0; k < 6; k++) { d.bodies.soft.impact(vb, vb.toWorld([0.3, 0.3, 0.3]), [0, -14, 0], 1); await w(70); }
}), 8000, [3200, 4400, 7500]);
console.log('metal', JSON.stringify(metal.by), 'baked', metal.stats.baked || 0, JSON.stringify(metal.bodies.filter(b => b.mat === 6)));
check(!metal.by['fracture:bend'], 'metal never bursts');
check((metal.by.bend || 0) >= 1 && (metal.stats.baked || 0) >= 1, `metal bends (${metal.by.bend || 0} bend events) and its bend is baked (${metal.stats.baked || 0})`);

// dirt: a lump dropped onto the field crumbles into clods and leaves a mound
const dirt = await scene('dirt', W(async () => {
    const d = ctx.destruction, B = d.brushes, w = (ms) => new Promise(r => setTimeout(r, ms));
    ctx.camera.position.set(4, 6, -16); ctx.camera.lookAt(4, 2, -4);
    d.carve(B.box([3.6, 0, -4.4], [4.4, 8, -3.6]), { op: 'add', mat: 0 });
    d.carve(B.box([2.5, 8, -5.5], [5.5, 10.5, -2.5]), { op: 'add', mat: 1 });
    await w(1500);
    d.carve(B.box([3, 1, -5], [5, 7.5, -3]), { hardness: false });
}), 5000, [2600, 3600]);
console.log('dirt', JSON.stringify(dirt.by), JSON.stringify(dirt.ev.filter(e => e.t !== 'bend').slice(0, 3)));
check((dirt.by['fracture:crumble'] || 0) >= 1 && (dirt.by.crumble || 0) >= 1, `dirt crumbles (${dirt.ev.filter(e => e.t === 'fracture').map(e => e.pieces).join(', ')} clods)`);
check((dirt.by['destroyed'] || 0) >= 1, 'the crumbs and the mound edit go through');

// chips: a stone carve's 'chips' event makes a few short-lived chip bodies
const chips = await page.evaluate(async () => {
    const b = ctx.destruction.bodies, n0 = b.list.size;
    ctx.events.dispatchEvent(new CustomEvent('chips', { detail: { point: [0, 3, 10], mat: 0, count: 3 } }));
    const made = [...b.list].filter(v => v.prop.userData.chip).length;
    await new Promise(r => setTimeout(r, 9500));
    return { made, left: [...b.list].filter(v => v.prop.userData.chip && !v.dead).length, stamped: b.stats.stamped };
});
check(chips.made >= 1 && chips.left === 0, `chips: ${chips.made} made, ${chips.left} left after 9.5 s`);

const cost = await page.evaluate(() => { const b = ctx.destruction.bodies; return { frameMs: +b.stats.frameMs.toFixed(3), frameMsMax: +b.stats.frameMsMax.toFixed(2), softMain: +(b.soft.stats.mainMs || 0).toFixed(3), workerMs: +(b.soft.stats.msMax || 0).toFixed(2) }; });
console.log('cost', JSON.stringify(cost));
check(cost.workerMs < 8, `soft debris worker peak ${cost.workerMs} ms per step`);
console.log(errors.length ? errors.slice(0, 5) : 'no console errors');
check(!errors.length, 'no console errors');
console.log(fails ? `${fails} FAILED` : 'all ok');
await browser.close();
process.exit(fails ? 1 : 0);
