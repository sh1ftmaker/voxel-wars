/** Mesh worker: { id, key, sdf, mat, dims? } (padded window, transferred) -> { id, key, mesh, sdf, mat } (transferred back). */
import { surfaceNets } from '../voxel/surfaceNets.js';
import { CHUNK } from '../config.js';

self.onmessage = (e) => {
    const { id, key, sdf, mat, dims } = e.data;
    const mesh = dims ? surfaceNets(sdf, mat, dims[0], dims[1], dims[2]) : surfaceNets(sdf, mat, CHUNK);
    self.postMessage({ id, key, mesh, sdf, mat }, [mesh.positions.buffer, mesh.normals.buffer, mesh.materials.buffer, mesh.ao.buffer, mesh.indices.buffer, sdf.buffer, mat.buffer]);
};
