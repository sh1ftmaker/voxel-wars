// Builds the benchmark scene shared by every runner (Rapier, box3d wasm, box3d native): the real Fort War terrain
// trimeshes around the red fort's corner tower, and the tower cut into Voronoi pieces as box compounds (exactly as
// tools/test/colliders.mjs 'boxes'), replicated `copies` times side by side.
//   f32 binary: [nMeshes, (nVerts, nTris, verts xyz..., indices...)..., nBodies,
//                (px py pz vx vy vz wx wy wz, nBoxes, (hx hy hz cx cy cz density)...)...]
import { VoxelWorld } from '../../../src/voxel/VoxelWorld.js';
import { voxelize } from '../../../src/voxel/voxelize.js';
import { surfaceNets } from '../../../src/voxel/surfaceNets.js';
import { Level } from '../../../src/level/fortwar.js';
import { box } from '../../../src/voxel/brushes.js';
import { CHUNK, PAD, CHUNK_M, VOXEL } from '../../../src/config.js';
import { findIslands, detachIsland, splitGrid, voronoiLabels, gridBoxes, gridStats } from '../../../src/voxel/islands.js';

export function buildScene({ copies = 1 } = {}) {
    const world = new VoxelWorld();
    voxelize(world, new Level());
    world.applyBrush(box([-42, 0.2, 9.2], [-35.5, 8, 9.9]), { hardness: false });
    const r = world.applyBrush(box([-39.8, 0.2, 9.5], [-39.1, 8, 13.6]), { hardness: false });
    const isl = findIslands(world, r.box[0], r.box[1]).islands[0];
    const tower = detachIsland(world, isl, { notify: false }).grid;
    let rs = 1;
    const rand = () => { rs = (rs * 16807) % 2147483647; return rs / 2147483647; };
    const pieces = splitGrid(tower, voronoiLabels(tower, [2, 1, 2], 40, rand)).filter(p => p.count > 24);
    const meshes = [];
    const P = CHUNK + 2 * PAD, sdf = new Int8Array(P ** 3), mat = new Uint8Array(P ** 3);
    for(const c of world.chunks.values()) {
        if(Math.abs(c.cx * CHUNK_M + 36) > 20 || Math.abs(c.cz * CHUNK_M - 12) > 20 + (copies - 1) * 6) continue;
        if(!world.extractPadded(c.cx, c.cy, c.cz, sdf, mat)) continue;
        const m = surfaceNets(sdf, mat, CHUNK);
        if(!m.indices.length) continue;
        const v = Float32Array.from(m.positions);
        for(let i = 0; i < v.length; i += 3) { v[i] += c.cx * CHUNK_M; v[i + 1] += c.cy * CHUNK_M; v[i + 2] += c.cz * CHUNK_M; }
        meshes.push({ v, idx: Int32Array.from(m.indices) });
    }
    const bodies = [];
    for(let k = 0; k < copies; k++) for(const g of pieces) {
        const o = g.offset, st = gridStats(g);
        const bs = gridBoxes(g, g.count > 400 ? 2 : 1);
        const vol = bs.reduce((a, x) => a + 8 * x.h[0] * x.h[1] * x.h[2], 0);
        bodies.push({
            p: [(tower.offset[0] + o[0]) * VOXEL, (tower.offset[1] + o[1]) * VOXEL + 2 + k * 9, (tower.offset[2] + o[2]) * VOXEL + (k % 3) * 0.5],
            v: [rand() * 4 - 2, 0, rand() * 4 - 2], w: [rand() - 0.5, rand() - 0.5, rand() - 0.5],
            boxes: bs.map(x => [...x.h, ...x.c, st.mass / vol]),
        });
    }
    return { meshes, bodies };
}

export function packScene({ meshes, bodies }) {
    const f = [meshes.length];
    for(const m of meshes) { f.push(m.v.length / 3, m.idx.length / 3, ...m.v, ...m.idx); }
    f.push(bodies.length);
    for(const b of bodies) { f.push(...b.p, ...b.v, ...b.w, b.boxes.length); for(const x of b.boxes) f.push(...x); }
    return Float32Array.from(f);
}
