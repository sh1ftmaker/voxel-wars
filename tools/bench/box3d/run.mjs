// Rapier vs box3d (wasm, SIMD and scalar) on the same scene (scene.mjs); also writes the scene file for the native
// runner. Prints step cost and a transform hash per run (equal hashes = bit-identical simulations).
//   node tools/bench/box3d/run.mjs <out dir with box3d-*.mjs> [copies=1] [steps=240]
import RAPIER from '@dimforge/rapier3d-compat';
import { writeFileSync } from 'node:fs';
import { buildScene, packScene } from './scene.mjs';

const dir = process.argv[2], copies = +(process.argv[3] || 1), STEPS = +(process.argv[4] || 240);
const scene = buildScene({ copies });
const tris = scene.meshes.reduce((a, m) => a + m.idx.length / 3, 0), boxes = scene.bodies.reduce((a, b) => a + b.boxes.length, 0);
console.log(`scene: ${scene.meshes.length} terrain meshes (${tris} tris), ${scene.bodies.length} bodies, ${boxes} boxes`);
writeFileSync(`${dir}/scene-${copies}.bin`, Buffer.from(packScene(scene).buffer));

function fnv(f32) {
    const b = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
    let h = 2166136261;
    for(let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16).padStart(8, '0');
}
const report = (name, tb, tt, worst, awake, out) => {
    let minY = Infinity; for(let i = 1; i < out.length; i += 7) minY = Math.min(minY, out[i]);
    console.log(`${name.padEnd(14)} build ${tb.toFixed(1).padStart(6)} ms, ${STEPS} steps ${tt.toFixed(0).padStart(5)} ms (avg ${(tt / STEPS).toFixed(2)}, worst ${worst.toFixed(1)}), awake ${awake}, min y ${minY.toFixed(2)}, hash ${fnv(out)}`);
};

async function rapier() {
    await RAPIER.init();
    const t0 = performance.now();
    const rw = new RAPIER.World({ x: 0, y: -30, z: 0 });
    rw.timestep = 1 / 60;
    const fixed = rw.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for(const m of scene.meshes) rw.createCollider(RAPIER.ColliderDesc.trimesh(m.v, Uint32Array.from(m.idx)), fixed);
    const bs = scene.bodies.map(b => {
        const rb = rw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(true).setTranslation(...b.p)
            .setLinvel(...b.v).setAngvel({ x: b.w[0], y: b.w[1], z: b.w[2] }));
        for(const x of b.boxes) rw.createCollider(RAPIER.ColliderDesc.cuboid(x[0], x[1], x[2]).setTranslation(x[3], x[4], x[5]).setDensity(x[6]), rb);
        return rb;
    });
    const tb = performance.now() - t0;
    let worst = 0; const t1 = performance.now();
    for(let i = 0; i < STEPS; i++) { const s = performance.now(); rw.step(); worst = Math.max(worst, performance.now() - s); }
    const tt = performance.now() - t1;
    const out = new Float32Array(bs.length * 7); let awake = 0;
    bs.forEach((b, i) => { const p = b.translation(), q = b.rotation(); out.set([p.x, p.y, p.z, q.x, q.y, q.z, q.w], i * 7); if(!b.isSleeping()) awake++; });
    report('rapier', tb, tt, worst, awake, out);
    rw.free();
}

async function box3d(kind) {
    const M = await (await import(`${dir}/box3d-${kind}.mjs`)).default();
    const t0 = performance.now();
    M._bw_create(0, -30, 0, 1);
    for(const m of scene.meshes) {
        const pv = M._bw_malloc(m.v.byteLength), pi = M._bw_malloc(m.idx.byteLength);
        M.HEAPF32.set(m.v, pv >> 2); M.HEAP32.set(m.idx, pi >> 2);
        M._bw_add_mesh(pv, m.v.length / 3, pi, m.idx.length / 3);
        M._bw_free(pv); M._bw_free(pi);
    }
    for(const b of scene.bodies) {
        const id = M._bw_add_body(...b.p, ...b.v, ...b.w, 0);
        for(const x of b.boxes) M._bw_add_box(id, ...x);
    }
    const tb = performance.now() - t0;
    let worst = 0; const t1 = performance.now();
    for(let i = 0; i < STEPS; i++) { const s = performance.now(); M._bw_step(1 / 60, 4); worst = Math.max(worst, performance.now() - s); }
    const tt = performance.now() - t1;
    const po = M._bw_malloc(scene.bodies.length * 28);
    const awake = M._bw_read(po);
    report(`box3d-${kind}`, tb, tt, worst, awake, M.HEAPF32.slice(po >> 2, (po >> 2) + scene.bodies.length * 7));
    M._bw_destroy();
}

await rapier();
await box3d('simd'); await box3d('simd');
await box3d('scalar');
