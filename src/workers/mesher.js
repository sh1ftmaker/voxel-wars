/** Mesh worker: { id, key, sdf, mat, dims? } (padded window, transferred) -> { id, key, mesh, sdf, mat } (transferred back). */
import { surfaceNets } from '../voxel/surfaceNets.js';
import { CHUNK } from '../config.js';

self.onmessage = (e) => {
    const { id, key, sdf, mat, dims } = e.data;
    const mesh = dims ? surfaceNets(sdf, mat, dims[0], dims[1], dims[2]) : surfaceNets(sdf, mat, CHUNK);
    const transfer = [sdf.buffer, mat.buffer];
    for(const v of Object.values(mesh)) if(ArrayBuffer.isView(v)) transfer.push(v.buffer);
    self.postMessage({ id, key, mesh, sdf, mat }, transfer);
};
