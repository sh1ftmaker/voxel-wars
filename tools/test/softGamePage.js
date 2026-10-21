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
