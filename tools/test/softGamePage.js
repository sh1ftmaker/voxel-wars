// Bundled by tools/test/softgame.mjs: the soft ground system (SoftGround) on the real level with the real terrain
// renderer, terrain worker and mesher workers, rendered into a render target (headless SwiftShader WebGPU cannot
// present to a canvas). Loaded from /dist/ so the workers resolve.
import * as THREE from 'three/webgpu';
import { VoxelWorld } from '../../src/voxel/VoxelWorld.js';
import { voxelize } from '../../src/voxel/voxelize.js';
import { TerrainSync } from '../../src/voxel/TerrainSync.js';
import { Level } from '../../src/level/fortwar.js';
import { TerrainRenderer } from '../../src/render/TerrainRenderer.js';
import { SoftGround } from '../../src/soft/SoftGround.js';

const W = 768, Hh = 432;
window.setup = async (opts = {}) => {
    const renderer = new THREE.WebGPURenderer();
    await renderer.init();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x9cc4e8);
    scene.add(new THREE.HemisphereLight(0xdfefff, 0x554433, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(-3, 2, 4); scene.add(sun);
    const camera = new THREE.PerspectiveCamera(60, W / Hh, 0.1, 300);
    const world = new VoxelWorld();
    if(opts.sync) voxelize(world, new Level()); else await new TerrainSync(world, { worker: true }).init();
    const terrain = new TerrainRenderer(world, scene, camera);
    const p = opts.point || [-28, 0, -3];
    camera.position.set(p[0] - 7, p[1] + (opts.camY ?? 2), p[2] + 2); camera.lookAt(p[0], p[1] - 0.3, p[2]);
    terrain.remeshAll();
    while(terrain.pending > 0) await new Promise(r => setTimeout(r, 50));
    const events = new EventTarget();
    const ctx = { renderer, scene, camera, world, terrain, events, params: new URLSearchParams(opts.params || ''), destruction: { editHooks: [] } };
    const soft = new SoftGround(ctx);
    const rt = new THREE.RenderTarget(W, Hh, { depthBuffer: true });
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    window.__g = { renderer, scene, camera, world, terrain, soft, rt, p, ctx };
    return { enabled: soft.enabled, meshes: terrain.meshes.size };
};
window.frame = async (n = 1, dt = 1 / 60) => {
    const { renderer, scene, camera, soft } = window.__g;
    for(let i = 0; i < n; i++) {
        const t0 = performance.now();
        soft.update(dt);
        const cpu = performance.now() - t0;
        window.__cpu = Math.max(window.__cpu || 0, cpu);
        renderer.render(scene, camera);
        await new Promise(r => setTimeout(r, 0));
    }
    await renderer.getArrayBufferAsync(soft.sim.params.value, null, 0, 16);
    const z = soft.zones.map(z => ({ state: z.state, slot: z.slot, n: z.n, cells: z.count, life: +z.life.toFixed(2), maxU: z.maxU && +z.maxU.toFixed(3), plastic: z.plastic }));
    return { zones: z, stats: soft.stats, maxCpu: +(window.__cpu || 0).toFixed(3), pending: window.__g.terrain.pending };
};
window.grab = async () => {
    const { renderer, rt } = window.__g;
    const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, Hh);
    const c = document.createElement('canvas'); c.width = W; c.height = Hh;
    const g = c.getContext('2d'), img = g.createImageData(W, Hh);
    img.data.set(px.subarray(0, W * Hh * 4));
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
};
window.surfaceY = (x, z) => { const h = window.__g.world.raycast([x, 15, z], [0, -1, 0], 40); return h ? +h.point[1].toFixed(3) : null; };
/** Node builder cache growth when chunks are remeshed (each miss is a full material build). */
window.cacheTest = async () => {
    const { renderer, scene, camera, terrain, soft } = window.__g;
    const nodes = renderer._nodes;
    const before = nodes.nodeBuilderCache.size;
    let builds = 0;
    const orig = nodes._createNodeBuilder.bind(nodes);
    nodes._createNodeBuilder = (...a) => { builds++; return orig(...a); };
    const keys = [...terrain.meshes.keys()].slice(0, 30);
    for(const k of keys) terrain.remesh(k);
    while(terrain.pending) await new Promise(r => setTimeout(r, 20));
    renderer.render(scene, camera);
    renderer.render(scene, camera);
    return { before, after: nodes.nodeBuilderCache.size, builds, remeshed: keys.length };
};
/** GPU ground-rider gather (SoftSim.gather) at points around the zone vs the same trilinear lookup on the CPU from a
 *  readback of the node buffer: max difference (m). */
window.gatherTest = async () => {
    const { soft, p } = window.__g, sim = soft.sim;
    const NODE_CAP = 6144, pts = [], q = new Float32Array(64 * 4);
    for(let i = 0; i < 64; i++) { const a = i * 0.7, r = (i % 8) * 0.45; pts.push([p[0] + Math.cos(a) * r, p[1] - 0.3 + (i % 3) * 0.2, p[2] + Math.sin(a) * r]); q.set([...pts[i], 0], i * 4); }
    const pr = sim.gather(q, 64);
    if(!pr) return { error: 'busy' };
    const g = await pr;
    const P = sim.P, ref = [], all = new Float32Array(await sim.renderer.getArrayBufferAsync(sim.nPos.value));
    let maxD = 0, maxU = 0;
    for(let i = 0; i < 64; i++) {
        const [x, y, z] = pts[i], u = [0, 0, 0];
        for(let s = 0; s < 4; s++) {
            const A = P.subarray(s * 4, s * 4 + 4), B = P.subarray((4 + s) * 4, (4 + s) * 4 + 4), h = P[(8 + s) * 4 + 1];
            if(!(A[3] > 0.5)) continue;
            const gx = (x - A[0]) / h, gy = (y - A[1]) / h, gz = (z - A[2]) / h;
            if(!(gx >= 0 && gy >= 0 && gz >= 0 && gx < B[0] - 1 && gy < B[1] - 1 && gz < B[2] - 1)) continue;
            const ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz), fx = gx - ix, fy = gy - iy, fz = gz - iz;
            const nx = B[0] | 0, nxy = nx * (B[1] | 0), base = s * NODE_CAP + ix + iy * nx + iz * nxy;
            for(let c = 0; c < 8; c++) {
                const w = (c & 1 ? fx : 1 - fx) * ((c >> 1) & 1 ? fy : 1 - fy) * (c >> 2 ? fz : 1 - fz);
                const o = (base + (c & 1) + nx * ((c >> 1) & 1) + nxy * (c >> 2)) * 4;
                for(let k = 0; k < 3; k++) u[k] += all[o + k] * w;
            }
        }
        for(let k = 0; k < 3; k++) { maxD = Math.max(maxD, Math.abs(u[k] - g[i * 4 + k])); maxU = Math.max(maxU, Math.abs(u[k])); }
    }
    return { maxDiff: +maxD.toFixed(5), maxU: +maxU.toFixed(3) };
};
