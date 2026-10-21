// Terrain collider churn: create and destroy every chunk trimesh of the scene (what each terrain edit costs us),
// Rapier vs box3d (SAH and median-split BVH builds).
//   node tools/bench/box3d/churn.mjs <out dir>
import RAPIER from '@dimforge/rapier3d-compat';
import { buildScene } from './scene.mjs';

const dir = process.argv[2];
const { meshes } = buildScene({ copies: 1 });
const tris = meshes.reduce((a, m) => a + m.idx.length / 3, 0);
console.log(`${meshes.length} chunk meshes, ${tris} tris (${(tris / meshes.length).toFixed(0)} per mesh)`);
const ROUNDS = 5;

await RAPIER.init();
{
    const rw = new RAPIER.World({ x: 0, y: -30, z: 0 });
    const fixed = rw.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const idx = meshes.map(m => Uint32Array.from(m.idx));
    let tc = 0, tr = 0, worst = 0;
    for(let r = 0; r < ROUNDS; r++) {
        const cs = [];
        for(let i = 0; i < meshes.length; i++) { const s = performance.now(); cs.push(rw.createCollider(RAPIER.ColliderDesc.trimesh(meshes[i].v, idx[i]), fixed)); const d = performance.now() - s; tc += d; worst = Math.max(worst, d); }
        rw.step();
        const s = performance.now(); for(const c of cs) rw.removeCollider(c, false); tr += performance.now() - s;
        rw.step();
    }
    const n = ROUNDS * meshes.length;
    console.log(`rapier        create ${(tc / n).toFixed(3)} ms/mesh (worst ${worst.toFixed(2)}), remove ${(tr / n).toFixed(3)} ms/mesh`);
}
for(const median of [0, 1]) {
    const M = await (await import(`${dir}/box3d-simd.mjs`)).default();
    M._bw_create(0, -30, 0, 1);
    M._bw_mesh_median(median);
    let tc = 0, tr = 0, worst = 0;
    for(let r = 0; r < ROUNDS; r++) {
        const ids = [];
        for(const m of meshes) {
            const s = performance.now();
            const pv = M._bw_malloc(m.v.byteLength), pi = M._bw_malloc(m.idx.byteLength);
            M.HEAPF32.set(m.v, pv >> 2); M.HEAP32.set(m.idx, pi >> 2);
            ids.push(M._bw_add_mesh(pv, m.v.length / 3, pi, m.idx.length / 3));
            M._bw_free(pv); M._bw_free(pi);
            const d = performance.now() - s; tc += d; worst = Math.max(worst, d);
        }
        M._bw_step(1 / 60, 4);
        const s = performance.now(); for(const i of ids) M._bw_remove_mesh(i); tr += performance.now() - s;
        M._bw_step(1 / 60, 4);
    }
    const n = ROUNDS * meshes.length;
    console.log(`box3d ${median ? 'median' : 'SAH   '}  create ${(tc / n).toFixed(3)} ms/mesh (worst ${worst.toFixed(2)}), remove ${(tr / n).toFixed(3)} ms/mesh`);
    M._bw_destroy();
}
