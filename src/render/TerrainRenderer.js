/**
 * Draws the VoxelWorld: one mesh per chunk, meshed in the worker pool and remeshed whenever an edit dirties it.
 * Chunk meshes sit at their chunk's world origin; geometry attributes: position, normal, ao (float), mat (float id).
 */
import * as THREE from 'three/webgpu';
import { CHUNK_M } from '../config.js';
import { MeshPool } from '../voxel/MeshPool.js';
import { createTerrainMaterial, meshMaterial } from './terrainMaterial.js';
import { geometryFromMesh } from './geometry.js';

export class TerrainRenderer {
    constructor(world, scene, camera) {
        this.world = world;
        this.scene = scene;
        this.camera = camera;
        this.group = new THREE.Group();
        this.group.name = 'terrain';
        scene.add(this.group);
        this.meshes = new Map();
        this.material = createTerrainMaterial();
        this.listeners = [];
        this.pool = new MeshPool({
            onMesh: (key, mesh) => this._apply(key, mesh),
            priority: (key) => {
                const c = world.chunks.get(key), p = camera.position;
                if(!c) return -1; // one-shot grids (detached bodies) first
                return Math.hypot((c.cx + 0.5) * CHUNK_M - p.x, (c.cy + 0.5) * CHUNK_M - p.y, (c.cz + 0.5) * CHUNK_M - p.z);
            },
        });
        // edits from the terrain worker come with the dirty chunks' padded windows (no extraction on this thread)
        world.onChange(({ dirty, windows }) => { for(const k of dirty) { const w = windows?.get(k); if(w) this.remeshWindow(k, w); else this.remesh(k); } });
    }
    /** The shared material for detached bodies (createTerrainMaterial({ local: true })): triplanar in object space,
     *  so textures stick to a moving piece. One instance for all bodies keeps a single pipeline. */
    get bodyMaterial() { return this._bodyMaterial ||= createTerrainMaterial({ local: true }); }
    /** Called with (key, geometry | null) after a chunk's mesh changes. */
    onChunkMesh(fn) { this.listeners.push(fn); }
    remeshAll() { for(const k of this.world.chunks.keys()) this.remesh(k); }
    remesh(key) {
        const c = this.world.chunks.get(key);
        if(!c) return;
        this.pool.request(key, (sdf, mat) => this.world.extractPadded(c.cx, c.cy, c.cz, sdf, mat));
    }
    /** Remesh a chunk from a ready padded window { sdf, mat } ({ empty: true }: nothing to mesh). */
    remeshWindow(key, w) {
        this.pool.request(key, (sdf, mat) => {
            if(w.empty) return false;
            sdf.set(w.sdf); mat.set(w.mat);
            this.world.remote?.recycle(w.sdf, w.mat); w.sdf = w.mat = null; w.empty = true; // (a window is used once)
            return true;
        });
    }
    get pending() { return this.pool.pending; }
    _apply(key, mesh) {
        let m = this.meshes.get(key);
        if(!mesh || !mesh.indices.length) {
            if(m) { this.group.remove(m); m.geometry.dispose(); this.meshes.delete(key); }
            for(const fn of this.listeners) fn(key, null);
            return;
        }
        const g = geometryFromMesh(mesh);
        if(m) { m.geometry.dispose(); m.geometry = g; m.material = meshMaterial(this.material, g); }
        else {
            const c = this.world.chunks.get(key);
            m = new THREE.Mesh(g, meshMaterial(this.material, g));
            m.position.set(c.cx * CHUNK_M, c.cy * CHUNK_M, c.cz * CHUNK_M);
            m.castShadow = true; m.receiveShadow = true;
            m.matrixAutoUpdate = false; m.updateMatrix();
            m.userData.chunkKey = key;
            this.group.add(m);
            this.meshes.set(key, m);
        }
        for(const fn of this.listeners) fn(key, g);
    }
}
