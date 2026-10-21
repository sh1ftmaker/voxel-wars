/** Terrain worker: runs TerrainCore (src/voxel/TerrainCore.js), the authoritative VoxelWorld and every edit of it.
 *  Messages in order; each reply { id, ... } transfers its chunk arrays and grids. Errors reply { id, error }. */
import { TerrainCore } from '../voxel/TerrainCore.js';

const core = new TerrainCore();
self.onmessage = (e) => {
    const msg = e.data;
    try {
        const t0 = performance.now();
        const { reply, transfer } = core.handle(msg);
        reply.workerMs = performance.now() - t0;
        self.postMessage(reply, transfer);
    } catch(err) {
        self.postMessage({ id: msg.id, type: msg.type, error: String(err?.stack || err) });
    }
};
