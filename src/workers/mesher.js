/** Mesh worker: { id, key, sdf, mat, dims? } (padded window, transferred) -> { id, key, mesh, sdf, mat } (transferred back).
 *  The mesh comes post-processed by prepMesh (src/voxel/meshPrep.js): matBlend, matF, bounds, octants for chunks. */
import { surfaceNets } from '../voxel/surfaceNets.js';
import { CHUNK, CHUNK_M } from '../config.js';
import { prepMesh } from '../voxel/meshPrep.js';

self.onmessage = (e) => {
    const { id, key, sdf, mat, dims } = e.data;
    const mesh = dims ? surfaceNets(sdf, mat, dims[0], dims[1], dims[2]) : surfaceNets(sdf, mat, CHUNK);
    // attributes, bounds and (for terrain chunks "cx,cy,cz") collider octants, off the main thread (src/voxel/meshPrep.js)
    if(mesh.indices.length) prepMesh(mesh, dims ? null : key.split(',').map(v => +v * CHUNK_M));
    const transfer = [sdf.buffer, mat.buffer];
    for(const v of Object.values(mesh)) if(ArrayBuffer.isView(v)) transfer.push(v.buffer);
    if(mesh.octants) for(const o of mesh.octants) if(o) transfer.push(o.vtx.buffer, o.ind.buffer);
    self.postMessage({ id, key, mesh, sdf, mat }, transfer);
};
