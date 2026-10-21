/**
 * Mesh post-processing that used to run on the main thread, done in the mesh worker (src/workers/mesher.js) right
 * after meshing. Pure (no three.js, no Rapier).
 *
 *   prepMesh(mesh, origin?) adds to a surfaceNets mesh:
 *     matBlend  Float32Array vec3 per vertex (material A, material B, blend), the terrain material's attribute
 *     matF      Float32Array material id A per vertex (the 'mat' attribute)
 *     bounds    Float32Array [minX, minY, minZ, maxX, maxY, maxZ, cx, cy, cz, radius] (bounding box and sphere)
 *     octants   (when `origin` = the chunk's world position in metres) the chunk's static collider data: 8 slots,
 *               null or { vtx: Float32Array world positions, ind: Uint32Array, hash } (a triangle goes to the
 *               octant of its centroid; Physics.setChunkCollider builds a trimesh per octant and skips octants whose
 *               hash did not change)
 */
import { CHUNK_M } from '../config.js';

export function prepMesh(mesh, origin = null) {
    const n = mesh.positions.length / 3;
    const A = mesh.materials, B = mesh.materials2 || A, W = mesh.blend;
    const m = new Float32Array(n * 3), mf = new Float32Array(n);
    for(let i = 0; i < n; i++) { m[i * 3] = A[i]; m[i * 3 + 1] = B[i]; m[i * 3 + 2] = W ? W[i] : 0; mf[i] = A[i]; }
    mesh.matBlend = m; mesh.matF = mf;
    const p = mesh.positions;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for(let i = 0; i < p.length; i += 3) {
        const x = p[i], y = p[i + 1], z = p[i + 2];
        if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y; if(z < z0) z0 = z; if(z > z1) z1 = z;
    }
    // sphere as three.js computes it: the box centre, the largest distance of a vertex from it
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    let r2 = 0;
    for(let i = 0; i < p.length; i += 3) { const dx = p[i] - cx, dy = p[i + 1] - cy, dz = p[i + 2] - cz, d = dx * dx + dy * dy + dz * dz; if(d > r2) r2 = d; }
    mesh.bounds = new Float32Array([x0, y0, z0, x1, y1, z1, cx, cy, cz, Math.sqrt(r2)]);
    if(origin) mesh.octants = octants(p, mesh.indices, origin);
    return mesh;
}

/** The per-octant collider arrays and hashes (same split and hash as Physics.setChunkCollider). */
export function octants(pos, idx, [ox, oy, oz]) {
    const H = CHUNK_M / 2;
    const nt = idx.length / 3, nv = pos.length / 3;
    const oct = new Uint8Array(nt), count = new Int32Array(8);
    for(let t = 0; t < nt; t++) {
        const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, d = idx[t * 3 + 2] * 3;
        const o = ((pos[a] + pos[b] + pos[d]) >= 3 * H ? 1 : 0) | ((pos[a + 1] + pos[b + 1] + pos[d + 1]) >= 3 * H ? 2 : 0) | ((pos[a + 2] + pos[b + 2] + pos[d + 2]) >= 3 * H ? 4 : 0);
        oct[t] = o; count[o]++;
    }
    const remap = new Int32Array(nv), stamp = new Int32Array(nv);
    const out = [];
    for(let o = 0; o < 8; o++) {
        if(!count[o]) { out.push(null); continue; }
        const ind = new Uint32Array(count[o] * 3);
        const vtx = new Float32Array(count[o] * 9); // at most 3 new vertices per triangle; trimmed below
        let ni = 0, vn = 0, h = 0x811c9dc5 ^ count[o];
        for(let t = 0; t < nt; t++) {
            if(oct[t] !== o) continue;
            for(let k = 0; k < 3; k++) {
                const v = idx[t * 3 + k];
                if(stamp[v] !== o + 1) {
                    stamp[v] = o + 1; remap[v] = vn;
                    const x = pos[v * 3] + ox, y = pos[v * 3 + 1] + oy, z = pos[v * 3 + 2] + oz;
                    vtx[vn * 3] = x; vtx[vn * 3 + 1] = y; vtx[vn * 3 + 2] = z; vn++;
                    // hash the float32 positions (what the trimesh gets)
                    h = Math.imul(h ^ Math.round(Math.fround(x) * 4096), 16777619); h = Math.imul(h ^ Math.round(Math.fround(y) * 4096), 16777619); h = Math.imul(h ^ Math.round(Math.fround(z) * 4096), 16777619);
                }
                ind[ni++] = remap[v];
                h = Math.imul(h ^ remap[v], 16777619);
            }
        }
        out.push({ vtx: vtx.slice(0, vn * 3), ind, hash: h });
    }
    return out;
}
