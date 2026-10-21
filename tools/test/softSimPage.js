// Bundled by tools/test/softsim.mjs: runs the soft ground GPU solver on the real level without the game (headless WebGPU).
import * as THREE from 'three/webgpu';
import { VoxelWorld } from '../../src/voxel/VoxelWorld.js';
import { voxelize } from '../../src/voxel/voxelize.js';
import { Level } from '../../src/level/fortwar.js';
import { SoftSim } from '../../src/soft/SoftSim.js';
import { classifyZone, bakeZone, H, SPC, NODE_CAP, CORNER_OF, CORNER_TETS } from '../../src/soft/core.js';
import { readRegion } from '../../src/soft/region.js';
import { BEDROCK_SAMPLES } from '../../src/config.js';

window.runTest = async (opts = {}) => {
    const log = [];
    const renderer = new THREE.WebGPURenderer();
    await renderer.init();
    log.push('backend ' + (renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl'));
    const world = new VoxelWorld();
    voxelize(world, new Level());
    globalThis.__softDebug = !!opts.debugNode;
    const sim = new SoftSim(renderer, { iterations: opts.iters || 4 });
    if(opts.stiff != null) for(const v of sim.u.mat.array) v.x = opts.stiff;
    if(opts.damp != null) for(const v of sim.u.mat.array) v.y = opts.damp;
    if(opts.plast != null) for(const v of sim.u.mat.array) v.z = opts.plast;
    sim.warmup();
    const p = opts.point || [-58, 0.1, 6];
    const c0 = [Math.floor((p[0] - 4) / H), Math.floor((p[1] - 3) / H), Math.floor((p[2] - 4) / H)], n = [16, 10, 16];
    const lo = c0.map(v => (v - 1) * SPC), hi = c0.map((v, i) => (v + n[i] + 1) * SPC);
    let t0 = performance.now();
    const region = readRegion(world, lo, hi);
    const tRead = performance.now() - t0; t0 = performance.now();
    const z = classifyZone(region, c0, n, world.smin[1] + BEDROCK_SAMPLES);
    log.push(`read ${tRead.toFixed(2)} ms classify ${(performance.now() - t0).toFixed(2)} ms cells ${z.count}`);
    sim.upload(0, { n, ...z });
    sim.slotA[0].set(c0[0] * H, c0[1] * H, c0[2] * H, 1);
    sim.slotB[0].set(n[0] + 1, n[1] + 1, n[2] + 1, z.count);
    sim.setExtent(0);
    const k = sim.u;
    sim.kickA[0].set(p[0], p[1], p[2], opts.radius || 3);
    sim.kickB[0].set(...(opts.dir || [0, 0, 0]), opts.speed || 8);
    sim.kickC[0].set(0, opts.up ?? 0.4, 0, 0);
    sim.run(0, { init: 1, kicks: true });
    sim.kickA[0].w = 0;
    const nodes = (n[0] + 1) * (n[1] + 1) * (n[2] + 1);
    const series = [];
    const frames = opts.frames || 90;
    if(opts.dumpShader) { const nb = renderer._nodes.getForCompute(sim.projectPasses[0]); log.push(nb.computeShader); }
    if(opts.debugNode) {
        const ci = new Int32Array(await renderer.getArrayBufferAsync(sim.cellIdx.value));
        const fl = new Int32Array(await renderer.getArrayBufferAsync(sim.nFlag.value));
        const ce = new Int32Array(await renderer.getArrayBufferAsync(sim.cells.value));
        let bad = 0; for(let i = 0; i < nodes; i++) if(ci[i] !== z.cellIdx[i] || fl[i] !== z.flags[i]) bad++;
        let badc = 0; for(let i = 0; i < z.count; i++) if(ce[i] !== z.cells[i]) badc++;
        log.push(`gpu mismatch nodes ${bad} cells ${badc}`);
        for(let i = 0, shown = 0; i < nodes && shown < 5; i++) if(ci[i] !== z.cellIdx[i]) { shown++; log.push(`node ${i}: gpu cell ${ci[i]} cpu ${z.cellIdx[i]} flag gpu ${fl[i]} cpu ${z.flags[i]}`); }
        const NX = n[0] + 1, NY = n[1] + 1, [a, b, c] = opts.debugNode;
        for(let sub = 0; sub < 3; sub++) {
            if(opts.separate) { renderer.compute(sim.predictPass); renderer.compute(sim.tetPass); renderer.compute(sim.projectPasses[0]); }
            else sim.run(1);
            const u = await sim.readSlot(0, nodes);
            const g = new Float32Array(await renderer.getArrayBufferAsync(sim.goals.value));
            const rows = [];
            for(let dz = -1; dz <= 1; dz++) for(let dy = 0; dy <= 1; dy++) for(let dx = -1; dx <= 1; dx++) {
                const i = (a + dx) + (b + dy) * NX + (c + dz) * NX * NY;
                rows.push(`${a + dx},${b + dy},${c + dz} f${z.flags[i] & 3} cell${z.cellIdx[i]} u=${[u[i * 4], u[i * 4 + 1], u[i * 4 + 2]].map(v => v.toFixed(3))}`);
            }
            log.push('sub ' + sub + '\n' + rows.join('\n'));
            // the goals the node gathers: its 4..8 cells, corner entries
            let sum = [0, 0, 0], ws = 0; const parts = [];
            for(let c8 = 0; c8 < 8; c8++) {
                const ox = c8 & 1, oy = (c8 >> 1) & 1, oz = c8 >> 2;
                const cx = a - 1 + ox, cy = b - 1 + oy, cz = c - 1 + oz;
                if(cx < 0 || cy < 0 || cz < 0 || cx >= n[0] || cy >= n[1] || cz >= n[2]) continue;
                const cell = z.cellIdx[cx + cy * NX + cz * NX * NY];
                if(cell < 0) continue;
                const corner = CORNER_OF[(1 - ox) + 2 * (1 - oy) + 4 * (1 - oz)], par = (cx + cy + cz) & 1;
                for(let j = 0; j < 4; j++) { const e = CORNER_TETS[par * 32 + corner * 4 + j]; if(e < 0) continue; const gi = (cell * 20 + e) * 4; parts.push(`c${cx},${cy},${cz} e${e}: ${[g[gi], g[gi + 1], g[gi + 2], g[gi + 3]].map(v => v.toFixed(2))}`); }
            }
            log.push(parts.join('\n'));
            for(const variant of ['noz', 'zonly', 'ok']) {
                let sz = 0, sw = 0;
                for(let c8 = 0; c8 < 8; c8++) {
                    const ox = c8 & 1, oy = (c8 >> 1) & 1, oz = c8 >> 2;
                    const cx = a - 1 + ox, cy = b - 1 + oy, cz = c - 1 + oz;
                    if(cx < 0 || cy < 0 || cz < 0 || cx >= n[0] || cy >= n[1] || cz >= n[2]) continue;
                    const idx = variant === 'noz' ? cx + cy * NX : variant === 'zonly' ? cz * NX * NY : cx + cy * NX + cz * NX * NY;
                    const cell = z.cellIdx[idx]; if(cell < 0) continue;
                    const corner = CORNER_OF[(1 - ox) + 2 * (1 - oy) + 4 * (1 - oz)], par = (cx + cy + cz) & 1;
                    for(let j = 0; j < 4; j++) { const e = CORNER_TETS[par * 32 + corner * 4 + j]; if(e < 0) continue; const gi = (cell * 20 + e) * 4; sz += g[gi + 2] * g[gi + 3]; sw += g[gi + 3]; }
                }
                log.push(variant + ' avg z ' + (sz / sw) + ' w ' + sw);
            }

            const ci = -1;
            if(ci >= 0) { const gg = []; for(let k = 0; k < 20; k++) gg.push([g[(ci * 20 + k) * 4], g[(ci * 20 + k) * 4 + 1], g[(ci * 20 + k) * 4 + 2], g[(ci * 20 + k) * 4 + 3]].map(v => v.toFixed(2)).join(' ')); log.push('goals of cell ' + ci + ' cell ' + (z.cells[ci] & 255) + ',' + ((z.cells[ci] >> 8) & 255) + ',' + ((z.cells[ci] >> 16) & 255) + '\n' + gg.join('\n')); }
        }
    }
    for(let f = 0; f < frames; f++) {
        if(f > frames - 20) sim.slotC[0].x = 30;
        sim.run(4);
        if(f % (opts.every || 6) === 0 || f === frames - 1) {
            const u = await sim.readSlot(0, nodes);
            let m = 0, sy = 0, nan = 0, mi = 0;
            // centre column displacement at the surface node closest to p
            for(let i = 0; i < nodes; i++) { const a = Math.hypot(u[i * 4], u[i * 4 + 1], u[i * 4 + 2]); if(Number.isNaN(a)) nan++; else if(a > m) { m = a; mi = i; } }
            const ci = Math.round(p[0] / H) - c0[0], cj = Math.round(p[1] / H) - c0[1], ck = Math.round(p[2] / H) - c0[2];
            const id = (ci + cj * (n[0] + 1) + ck * (n[0] + 1) * (n[1] + 1)) * 4;
            const NX = n[0] + 1, NY = n[1] + 1;
            series.push({ f, at: [mi % NX, Math.floor(mi / NX) % NY, Math.floor(mi / NX / NY), z.flags[mi] & 3, z.flags[mi] >> 8], max: +m.toFixed(3), centre: [u[id], u[id + 1], u[id + 2]].map(v => +v.toFixed(3)), nan });
        }
    }
    // GPU time of a frame's work (4 substeps): time 20 runs with a readback fence
    await renderer.getArrayBufferAsync(sim.nPos.value, null, 0, 16);
    t0 = performance.now();
    for(let i = 0; i < 20; i++) sim.run(4);
    const cpu = (performance.now() - t0) / 20;
    await renderer.getArrayBufferAsync(sim.nPos.value, null, 0, 16);
    const wall = (performance.now() - t0) / 20;
    const u = await sim.readSlot(0, nodes);
    t0 = performance.now();
    const bsr = readRegion(world, c0.map(v => v * SPC - 4), c0.map((v, i) => (v + n[i]) * SPC + 4));
    const patch = bakeZone(bsr, { s0: c0.map(v => v * SPC), n, u, bedrockY: world.smin[1] + BEDROCK_SAMPLES });
    log.push(`bake ${(performance.now() - t0).toFixed(2)} ms changed ${patch.changed}`);
    return { log, series, cpuPerFrame: +cpu.toFixed(3), wallPerFrame: +wall.toFixed(3) };
};

import { surfaceNets } from '../../src/voxel/surfaceNets.js';
import { geometryFromMesh } from '../../src/render/geometry.js';
import { createTerrainMaterial, enableTerrainDeform } from '../../src/render/terrainMaterial.js';
import { CHUNK, CHUNK_M, PAD } from '../../src/config.js';
import { Fn, uniform, normalLocal } from 'three/tsl';

/** Render a few chunks around p with the deforming terrain material; step(frames) advances the sim and renders. */
window.setupRender = async (opts = {}) => {
    const renderer = new THREE.WebGPURenderer({ antialias: false });
    await renderer.init();
    renderer.setSize(768, 432);
    document.body.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x9cc4e8);
    scene.add(new THREE.HemisphereLight(0xdfefff, 0x554433, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(-3, 2, 4); scene.add(sun);
    const world = new VoxelWorld();
    voxelize(world, new Level());
    const p = opts.point || [-28, 0.0, -3];
    const sim = new SoftSim(renderer, {});
    let mat;
    if(opts.plain) {
        // plain lit material with the same deformation (the terrain textures crash SwiftShader WebGPU)
        mat = new THREE.MeshStandardNodeMaterial({ color: 0x8a7a5a, roughness: 0.9 });
        if(!opts.noDeform) {
            const skip = uniform(0, 'int');
            mat.positionNode = Fn(() => { const d = sim.deformNode(skip); normalLocal.assign(d.normal); return d.position; })();
        }
    } else {
        mat = createTerrainMaterial();
        if(!opts.noDeform) enableTerrainDeform(mat, (skip) => sim.deformNode(skip));
    }
    const P = CHUNK + 2 * PAD, sdf = new Int8Array(P ** 3), mt = new Uint8Array(P ** 3);
    const pc = p.map(v => Math.floor(v / CHUNK_M));
    for(let cz = pc[2] - 1; cz <= pc[2] + 1; cz++) for(let cy = pc[1] - 1; cy <= pc[1]; cy++) for(let cx = pc[0] - 1; cx <= pc[0] + 1; cx++) {
        if(!world.extractPadded(cx, cy, cz, sdf, mt)) continue;
        const mesh = surfaceNets(sdf, mt, CHUNK, CHUNK, CHUNK);
        if(!mesh.indices.length) continue;
        const m = new THREE.Mesh(geometryFromMesh(mesh), mat);
        m.position.set(cx * CHUNK_M, cy * CHUNK_M, cz * CHUNK_M);
        scene.add(m);
    }
    const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 200);
    cam.position.set(p[0] - 6, p[1] + (opts.camY ?? 4), p[2] + 2); cam.lookAt(p[0], p[1] - 0.5, p[2]);
    if(opts.stiff != null) for(const v of sim.u.mat.array) v.x = opts.stiff;
    sim.warmup();
    const c0 = [Math.floor((p[0] - 5) / H), Math.floor((p[1] - 3) / H), Math.floor((p[2] - 5) / H)], n = [20, 10, 20];
    const region = readRegion(world, c0.map(v => (v - 1) * SPC), c0.map((v, i) => (v + n[i] + 1) * SPC));
    const z = classifyZone(region, c0, n, world.smin[1] + BEDROCK_SAMPLES);
    sim.upload(0, { n, ...z });
    sim.slotA[0].set(c0[0] * H, c0[1] * H, c0[2] * H, 1);
    sim.slotB[0].set(n[0] + 1, n[1] + 1, n[2] + 1, z.count);
    sim.setExtent(0);
    sim.run(0, { init: 1 });
    const rt = new THREE.RenderTarget(768, 432, { depthBuffer: true });
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    window.__r = { renderer, scene, cam, sim, p, rt };
    return { cells: z.count };
};
window.kick = (o = {}) => {
    const { sim, p } = window.__r, k = sim.u;
    sim.kickA[0].set(p[0], p[1], p[2], o.radius || 3);
    sim.kickB[0].set(...(o.dir || [0, 0, 0]), o.speed || 8);
    sim.kickC[0].set(0, o.up ?? 0.4, 0, 0);
    sim.run(0, { kicks: true });
    sim.kickA[0].w = 0;
};
window.step = async (frames = 1) => {
    const { renderer, scene, cam, sim } = window.__r;
    for(let i = 0; i < frames; i++) { sim.run(4); renderer.render(scene, cam); }
    const u = await sim.readSlot(0, 21 * 11 * 21);
    let m = 0; for(let i = 0; i < u.length; i += 4) m = Math.max(m, Math.hypot(u[i], u[i + 1], u[i + 2]));
    return m;
};

/** Pixels of the render target as a data URL (headless: the canvas swap chain crashes SwiftShader WebGPU). */
window.grab = async () => {
    const { renderer, rt } = window.__r;
    const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, 768, 432);
    const c = document.createElement('canvas'); c.width = 768; c.height = 432;
    const g = c.getContext('2d'), img = g.createImageData(768, 432);
    for(let y = 0; y < 432; y++) img.data.set(px.subarray(y * 3072, (y + 1) * 3072), y * 3072);
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
};
