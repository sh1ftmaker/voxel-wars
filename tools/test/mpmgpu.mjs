/**
 * The GPU solver (src/mpm/MpmGPU.js) and the grains' GPU draw path on a real GPU, without a browser: three.js's
 * WebGPU backend running on Dawn in Node (the `webgpu` package: `npm i --no-save webgpu`, or MPM_WEBGPU=<path to the
 * package> to use one installed elsewhere). Headless Chromium on Linux only offers WebGPU through SwiftShader (whose
 * device is lost after the first blast), so this is where the WebGPU path gets its GPU timings.
 *   1. compiles every kernel; GPU compute time per frame (timestamp queries) for 8k..64k sand particles in 1-4 zones
 *   2. the same sand column on the GPU and the CPU solver: the piles must agree; no NaNs; the zone stats readback
 *   3. renders the grains with GrainRenderer's GPU material into a render target -> <out>/mpmgpu-grains.png
 * node tools/test/mpmgpu.mjs [outDir] [--iters N]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const out = args[0] && !args[0].startsWith('--') ? args[0] : 'shots/mpm';
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 ? +args[i + 1] : d; };
const iters = val('--iters', 3);
fs.mkdirSync(out, { recursive: true });
let webgpu;
try { webgpu = await import(process.env.MPM_WEBGPU ? pathToFileURL(path.join(process.env.MPM_WEBGPU, 'index.js')).href : 'webgpu'); }
catch(e) { console.log(`skipped: the 'webgpu' package (Dawn for Node) is not installed (npm i --no-save webgpu, or MPM_WEBGPU=<dir>): ${e.message}`); process.exit(0); }
Object.assign(globalThis, webgpu.globals);
Object.defineProperty(globalThis, 'navigator', { value: { gpu: webgpu.create([]), userAgent: 'node' }, configurable: true, writable: true });
globalThis.self = globalThis;
globalThis.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 0);
const warn = console.warn; console.warn = (...a) => { if(!/terrain texture/.test(a[0])) warn(...a); }; // (no textures in Node: flat colours)

const THREE = await import('three/webgpu');
const { MpmGPU } = await import('../../src/mpm/MpmGPU.js');
const { MpmSolverCPU } = await import('../../src/mpm/cpuSolver.js');
const { GrainRenderer } = await import('../../src/mpm/GrainRenderer.js');
const P = await import('../../src/mpm/params.js');

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if(!ok) failed++; };
const canvas = { style: {}, width: 640, height: 360, addEventListener() {}, removeEventListener() {}, getContext() { return { configure() {}, unconfigure() {}, getCurrentTexture() { throw new Error('no canvas'); } }; } };
const renderer = new THREE.WebGPURenderer({ canvas, trackTimestamp: true });
await renderer.init();
const info = renderer.backend.device?.adapterInfo || {};
console.log(`backend: ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'other'} (Dawn) on ${info.vendor || ''} ${info.architecture || ''} ${info.description || ''}`);

const [nx, ny, nz] = P.ZONE_DIMS, ground = 4, dt = 1 / 60;
const sdf = new Int8Array(nx * ny * nz);
for(let k = 0; k < nz; k++) for(let j = 0; j < ny; j++) for(let i = 0; i < nx; i++) sdf[i + j * nx + k * nx * ny] = Math.max(-127, Math.min(127, (j - ground) * 32));
function column(side, height, seed = 7) {
    let r = seed; const rand = () => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x7fffffff; };
    const pos = [], mats = [];
    for(let k = 24 - side / 2; k < 24 + side / 2; k++) for(let j = ground; j < ground + height; j++) for(let i = 24 - side / 2; i < 24 + side / 2; i++) for(let q = 0; q < 8; q++) {
        pos.push(i + 0.25 + 0.5 * (q & 1) + (rand() - 0.5) * 0.2, j + 0.25 + 0.5 * ((q >> 1) & 1) + (rand() - 0.5) * 0.2, k + 0.25 + 0.5 * (q >> 2) + (rand() - 0.5) * 0.2);
        mats.push(3);
    }
    return { pos: Float32Array.from(pos), vel: null, mats: Uint8Array.from(mats), ppcLog: 0 };
}
const spawnOpts = { dt, gravity: P.GRAVITY, H: P.H, packW: P.packW, isSnow: () => false };
const globals = (sim) => sim.setGlobals({ gstep: P.GRAVITY * dt * dt / P.H, restD: 0.12 * dt / P.H, relaxScale: 1, restFrames: 20, vscale: dt / P.H, maxStep: 1 });

// ---- 1. timings
const results = [];
for(const [zones, side, height] of [[1, 12, 7], [1, 16, 8], [2, 16, 8], [4, 16, 8]]) {
    const sim = new MpmGPU(renderer);
    globals(sim);
    const col = column(side, height);
    for(let z = 0; z < zones; z++) { sim.setZone(z, { lo: [z * 60, 0, 0], sdf, wall: 0.6 }); sim.spawn(z, col, spawnOpts); }
    const n = sim.counts.reduce((a, b) => a + b, 0);
    const t0 = performance.now();
    sim.warmup();
    await renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE);
    const compileMs = performance.now() - t0;
    const ms = [];
    for(let f = 0; f < 120; f++) {
        sim.step({ substeps: 1, iterations: iters });
        if(f % 5 === 4) { const t = await renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE); if(f > 10 && t) ms.push(t / 5); }
    }
    ms.sort((a, b) => a - b);
    const r = { particles: n, zones, median: ms[ms.length >> 1], max: ms[ms.length - 1], compileMs };
    results.push(r);
    console.log(`${n} particles in ${zones} zone(s), ${iters} iterations: GPU compute ${r.median.toFixed(3)} ms per frame (max ${r.max.toFixed(3)}), first compile ${compileMs.toFixed(0)} ms`);
}
const r32 = results.find(r => r.particles === 32768);
check(r32 && r32.median < 2, `32k particles under 2 ms of GPU compute per frame (${r32?.median.toFixed(3)} ms)`);

// ---- 2. GPU vs CPU on the same column
{
    const sim = new MpmGPU(renderer);
    globals(sim);
    const col = column(6, 8);
    sim.setZone(0, { lo: [0, 0, 0], sdf, wall: 0.6 });
    sim.spawn(0, col, spawnOpts);
    for(let f = 0; f < 240; f++) sim.step({ substeps: 1, iterations: iters });
    const st = await sim.readStats();
    const g = await sim.readSlot(0);
    const cpu = new MpmSolverCPU({ cap: 8192 }); cpu.knobs.iterations = iters;
    cpu.setZone(0, { lo: [0, 0, 0], sdf, wall: 0.6 }); cpu.spawn(0, col.pos, null, col.mats, 0);
    for(let f = 0; f < 240; f++) cpu.step(dt);
    const prof = (get, n) => { const top = []; for(let p = 0; p < n; p++) { const [x, y, z] = get(p); const b = Math.floor(Math.hypot(x - 24, z - 24) * P.H / 0.25); top[b] = Math.max(top[b] ?? 0, (y - ground) * P.H); } return Array.from(top, v => v ?? 0); };
    const pg = prof(p => [g[p * 4], g[p * 4 + 1], g[p * 4 + 2]], g.length / 4), pc = prof(p => [cpu.x[p * 3], cpu.x[p * 3 + 1], cpu.x[p * 3 + 2]], cpu.n);
    let nan = 0; for(const v of g) if(!Number.isFinite(v)) nan++;
    console.log('GPU pile (m per 0.25 m ring):', pg.map(v => v.toFixed(2)).join(' '));
    console.log('CPU pile (m per 0.25 m ring):', pc.map(v => v.toFixed(2)).join(' '));
    const diff = Math.max(...pg.map((v, i) => Math.abs(v - (pc[i] ?? 0))));
    check(nan === 0, 'GPU: no NaNs');
    check(diff < 0.15, `GPU and CPU piles agree (largest difference ${diff.toFixed(3)} m)`);
    check(st[0] === col.mats.length && st[1] < st[0] * 0.03, `stats readback: ${st[0]} particles, ${st[1]} moving after 4 s`);
}

// ---- 3. the grains' GPU draw path
{
    const sim = new MpmGPU(renderer);
    globals(sim);
    const zsdf = new Int8Array(sdf);
    sim.setZone(0, { lo: [-24, -4, -24], sdf: zsdf, wall: 0.6 });
    const col = column(10, 6, 3);
    const mats = col.mats.map((_, i) => [3, 1, 4, 7][Math.floor(i / (col.mats.length / 4))]);
    sim.spawn(0, { ...col, mats }, spawnOpts);
    for(let f = 0; f < 20; f++) sim.step({ substeps: 1, iterations: iters });
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x9fc4e8);
    scene.add(new THREE.HemisphereLight(0xdfefff, 0x6b5a40, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(3, 6, 2); scene.add(sun);
    const gr = new GrainRenderer(scene, { gpu: sim });
    gr.setSlots(sim.maxSlot);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12).rotateX(-Math.PI / 2), new THREE.MeshStandardNodeMaterial({ color: 0x55703a }));
    scene.add(floor);
    const cam = new THREE.PerspectiveCamera(50, 640 / 360, 0.05, 100);
    cam.position.set(3.2, 2.2, 3.6); cam.lookAt(0, 0.5, 0);
    const rt = new THREE.RenderTarget(640, 360, { samples: 1 });
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, 640, 360);
    writePNG(path.join(out, 'mpmgpu-grains.png'), px, 640, 360);
    let grainPx = 0;
    for(let i = 0; i < px.length; i += 4) { const r = px[i], g = px[i + 1], b = px[i + 2]; if(!(Math.abs(r - 0x9f) < 30 && Math.abs(b - 0xe8) < 40) && !(g > r && g > b)) grainPx++; }
    console.log(`rendered ${out}/mpmgpu-grains.png: ${grainPx} grain pixels (one instanced draw call)`);
    check(grainPx > 5000, 'the grains are drawn from the GPU buffers');
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);

function writePNG(file, rgba, w, h) {
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for(let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
    const crc = (buf) => { let c = ~0; for(const b of buf) { c ^= b; for(let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
