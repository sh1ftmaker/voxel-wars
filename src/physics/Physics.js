/**
 * Rigid body physics (Rapier). Owns the Rapier world, the terrain's static colliders (one trimesh per chunk, rebuilt
 * from each new chunk mesh), dynamic props, and a fixed 60 Hz step.
 *
 * Public API (other modules depend on these signatures; extend, don't break):
 *   await Physics.create(ctx)                      ctx: { world: VoxelWorld, terrain: TerrainRenderer, scene }
 *   physics.R                                      the RAPIER module
 *   physics.rw                                     the RAPIER.World
 *   physics.step(dt)                               advance (fixed substeps); call once per frame
 *   physics.addBody({ shape, size, position, velocity, angularVelocity, density, friction, restitution, mesh, userData, ccd })
 *        shape 'box' (size = half extents [x,y,z]) | 'sphere' (size = radius) | 'capsule' (size = [halfHeight, radius])
 *        returns a Prop { body, collider, mesh, userData }; `mesh` (THREE.Object3D, optional) follows the body
 *   physics.removeBody(prop)
 *   physics.raycast(origin, dir, maxDist, { exclude }) -> { point, normal, distance, collider, prop|null } | null
 *   physics.explode(center, radius, strength)      radial velocity change on dynamic bodies, falling off with distance
 *   physics.propOf(collider)                       the Prop owning a collider (null for terrain)
 *   physics.onStep(fn)                             fn(h) after every fixed substep
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { CHUNK_M } from '../config.js';

export const GRAVITY = 30; // m/s²: real gravity reads as slow motion at this scale (WorldParty's DEFAULT_BODY_GRAVITY)
export const STEP = 1 / 60;

export class Physics {
    static async create(ctx) {
        await RAPIER.init();
        return new Physics(ctx);
    }
    constructor({ world, terrain, scene }) {
        this.R = RAPIER;
        this.world = world;
        this.scene = scene;
        this.rw = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
        this.rw.timestep = STEP;
        this.terrainColliders = new Map(); // chunk key -> collider
        this.terrainBody = this.rw.createRigidBody(RAPIER.RigidBodyDesc.fixed());
        this.props = new Set();
        this.byCollider = new Map(); // collider handle -> prop
        this.stepListeners = [];
        this.acc = 0;
        terrain.onChunkMesh((key, geometry) => this.setChunkCollider(key, geometry));
    }

    /** Replace a chunk's static collider with a trimesh of its new render geometry (null removes it). */
    setChunkCollider(key, geometry) {
        const old = this.terrainColliders.get(key);
        if(old) { this.rw.removeCollider(old, false); this.terrainColliders.delete(key); }
        if(!geometry) return;
        const c = this.world.chunks.get(key);
        const src = geometry.attributes.position.array;
        const verts = new Float32Array(src.length);
        const ox = c.cx * CHUNK_M, oy = c.cy * CHUNK_M, oz = c.cz * CHUNK_M;
        for(let i = 0; i < src.length; i += 3) { verts[i] = src[i] + ox; verts[i + 1] = src[i + 1] + oy; verts[i + 2] = src[i + 2] + oz; }
        const desc = RAPIER.ColliderDesc.trimesh(verts, new Uint32Array(geometry.index.array)).setFriction(0.9);
        this.terrainColliders.set(key, this.rw.createCollider(desc, this.terrainBody));
        // bodies resting on the old collider must notice the change
        for(const p of this.props) if(p.body.isSleeping()) p.body.wakeUp();
    }

    addBody({ shape = 'box', size = [0.5, 0.5, 0.5], position = [0, 0, 0], quaternion, velocity, angularVelocity, density = 1000, friction = 0.7, restitution = 0.1, mesh = null, userData = {}, ccd = true, kinematic = false } = {}) {
        const R = RAPIER;
        const bd = (kinematic ? R.RigidBodyDesc.kinematicPositionBased() : R.RigidBodyDesc.dynamic()).setTranslation(...position).setCcdEnabled(ccd);
        if(quaternion) bd.setRotation({ x: quaternion[0], y: quaternion[1], z: quaternion[2], w: quaternion[3] });
        if(velocity) bd.setLinvel(...velocity);
        if(angularVelocity) bd.setAngvel({ x: angularVelocity[0], y: angularVelocity[1], z: angularVelocity[2] });
        const body = this.rw.createRigidBody(bd);
        const cd = shape === 'sphere' ? R.ColliderDesc.ball(size)
            : shape === 'capsule' ? R.ColliderDesc.capsule(size[0], size[1])
            : R.ColliderDesc.cuboid(size[0], size[1], size[2]);
        cd.setDensity(density).setFriction(friction).setRestitution(restitution);
        const collider = this.rw.createCollider(cd, body);
        const prop = { body, collider, mesh, userData };
        this.props.add(prop);
        this.byCollider.set(collider.handle, prop);
        if(mesh) { mesh.matrixAutoUpdate = true; this.scene.add(mesh); }
        return prop;
    }
    removeBody(prop) {
        if(!this.props.delete(prop)) return;
        this.byCollider.delete(prop.collider.handle);
        this.rw.removeRigidBody(prop.body);
        if(prop.mesh) prop.mesh.removeFromParent();
    }
    propOf(collider) { return collider ? this.byCollider.get(collider.handle) || null : null; }

    raycast(origin, dir, maxDist = 100, { exclude } = {}) {
        const ray = new RAPIER.Ray({ x: origin[0], y: origin[1], z: origin[2] }, { x: dir[0], y: dir[1], z: dir[2] });
        const hit = this.rw.castRayAndGetNormal(ray, maxDist, true, undefined, undefined, undefined, exclude?.body ?? exclude);
        if(!hit) return null;
        const t = hit.timeOfImpact;
        return { point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t], normal: [hit.normal.x, hit.normal.y, hit.normal.z], distance: t, collider: hit.collider, prop: this.propOf(hit.collider) };
    }

    explode(center, radius, strength) {
        for(const p of this.props) {
            if(!p.body.isDynamic()) continue;
            const t = p.body.translation();
            const dx = t.x - center[0], dy = t.y - center[1], dz = t.z - center[2];
            const d = Math.hypot(dx, dy, dz);
            if(d > radius) continue;
            const k = strength * (1 - d / radius) / Math.max(d, 0.3);
            const v = p.body.linvel();
            p.body.setLinvel({ x: v.x + dx * k, y: v.y + dy * k + strength * 0.3 * (1 - d / radius), z: v.z + dz * k }, true);
            const a = p.body.angvel();
            p.body.setAngvel({ x: a.x + (Math.random() - 0.5) * strength * 0.5, y: a.y + (Math.random() - 0.5) * strength * 0.5, z: a.z + (Math.random() - 0.5) * strength * 0.5 }, true);
        }
    }

    onStep(fn) { this.stepListeners.push(fn); }

    step(dt) {
        this.acc = Math.min(this.acc + dt, STEP * 4);
        while(this.acc >= STEP) {
            this.rw.step();
            for(const fn of this.stepListeners) fn(STEP);
            this.acc -= STEP;
        }
        for(const p of this.props) {
            if(!p.mesh) continue;
            const t = p.body.translation(), r = p.body.rotation();
            p.mesh.position.set(t.x, t.y, t.z);
            p.mesh.quaternion.set(r.x, r.y, r.z, r.w);
        }
    }
}
