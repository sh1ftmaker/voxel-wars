/**
 * A detached piece of terrain: a small voxel grid (islands.js Grid: Int8 distances + materials, padded for the
 * mesher) riding on a dynamic box3d body. Created and managed by VoxelBodies (src/physics/VoxelBodies.js).
 *
 * Frames: grid-local metres put local sample i at i * VOXEL. The body's origin is the grid's centre of mass at
 * creation (`frame`, grid-local), so body.translation() is the middle of the piece (holding and throwing code can
 * treat it like any prop): world = T + R * (local - frame).
 *
 * Collider: a compound of at most 12 (fracture pieces 2-4, islands.maxBoxesFor) greedily merged boxes (at 1, 2, ... samples per cell, tightened to the solid
 * samples): concave pieces keep their shape, and box-mesh contacts are cheap. Mass from material densities; box3d's
 * continuous collision keeps fast pieces out of the terrain. Hit events feed VoxelBodies' impacts.
 *
 * The Prop (physics.addProp) has userData { voxelBody, mat, volume, mass } plus whatever the creator passed.
 */
import * as THREE from 'three/webgpu';
import { VOXEL } from '../config.js';
import { MATERIALS } from './materials.js';
import { gridStats, colliderBoxes, gridHullPoints } from './islands.js';
import { geometryFromMesh } from '../render/geometry.js';
import { meshMaterial } from '../render/terrainMaterial.js';
import { GROUPS_ALL } from '../physics/Physics.js';


const _q = new THREE.Quaternion(), _v = new THREE.Vector3();

export class VoxelBody {
    /**
     * @param mgr VoxelBodies
     * @param grid islands.js Grid
     * @param opts { origin: world position of grid-local 0 (metres), rotation [x,y,z,w], linvel, angvel, generation, userData,
     *              prep: islands.gridPrep(grid, generation) when already computed (e.g. by the terrain worker) }
     */
    constructor(mgr, grid, { origin, rotation = [0, 0, 0, 1], linvel = [0, 0, 0], angvel = [0, 0, 0], generation = 0, userData = {}, waitKeys = null, sibling = 0, enabled = true, prep = null }) {
        this.mgr = mgr;
        // pieces of one fracture ignore each other for a moment (their shapes overlap a little at the cracks)
        this.sibling = sibling;
        this.prevV = [...linvel];
        // terrain chunks that still show this piece: the body ignores the terrain until they are remeshed
        this.waitKeys = waitKeys && waitKeys.length ? waitKeys : null;
        this.waitT = 0;
        this.grid = grid;
        this.generation = generation;
        this.age = 0;     // seconds alive
        this.still = 0;   // seconds asleep (or nearly)
        this.cool = 0;    // impact event cooldown
        this.version = 0; // mesh requests
        this.dead = false;
        this.stats = prep?.stats || gridStats(grid);
        if(prep?.stats) grid.count = prep.stats.count;
        this.frame = this.stats.com.slice();
        const { physics } = mgr;
        _q.set(rotation[0], rotation[1], rotation[2], rotation[3]);
        _v.set(this.frame[0], this.frame[1], this.frame[2]).applyQuaternion(_q);
        const body = physics.createBody({
            position: [origin[0] + _v.x, origin[1] + _v.y, origin[2] + _v.z], rotation: [...rotation],
            linvel: [...linvel], angvel: [...angvel], linearDamping: 0.02, angularDamping: 0.15, enabled,
        });
        this.group = new THREE.Group();
        this.group.position.set(origin[0] + _v.x, origin[1] + _v.y, origin[2] + _v.z);
        this.group.quaternion.copy(_q);
        this.group.visible = enabled; // a disabled body (a fracture piece being prepared) waits for activate()
        this.mesh = null;
        this.prop = physics.addProp({ body, colliders: [], mesh: this.group, userData: { ...userData, voxelBody: this } });
        this.updateUserData();
        this.buildColliders(prep && prep.generation === generation ? prep.boxes : null);
        this.meshed = this.remesh();
    }

    get body() { return this.prop.body; }
    get mat() { return this.stats.mat; }
    get mass() { return this.stats.mass; }
    get volume() { return this.stats.volume; }
    updateUserData() {
        const u = this.prop.userData;
        u.mat = this.stats.mat; u.volume = this.stats.volume; u.mass = this.stats.mass;
    }

    /** Rebuild the collider(s) from the grid (after carving). `boxes`: islands.colliderBoxes(grid, ...) if known. */
    buildColliders(boxes = null) {
        const { physics } = this.mgr;
        const g = this.grid, st = this.stats, f = this.frame;
        physics.detachColliders(this.prop);
        const specs = [];
        // boxes: box-mesh contacts are the cheapest against the terrain (and keep concave pieces' shape)
        // fracture pieces are roughly convex: a few boxes do; big detached islands keep more of their shape
        boxes ||= colliderBoxes(g, st.count, this.generation);
        const mass = Math.max(1, st.mass);
        if(boxes.length) {
            let vol = 0;
            for(const b of boxes) vol += b.h[0] * b.h[1] * b.h[2];
            // each box's density puts its share of the mass (by volume) in it
            const density = mass / (8 * vol);
            for(const b of boxes) specs.push({ shape: 'box', half: b.h, center: [b.c[0] - f[0], b.c[1] - f[1], b.c[2] - f[2]], density });
        } else {
            const pts = gridHullPoints(g);
            for(let i = 0; i < pts.length; i += 3) { pts[i] -= f[0]; pts[i + 1] -= f[1]; pts[i + 2] -= f[2]; }
            if(pts.length >= 12) specs.push({ shape: 'hull', points: pts, density: 1000 });
        }
        const fr = MATERIALS[st.mat]?.hardness > 2 ? 0.75 : 0.9;
        const groups = this.groups();
        let n = 0;
        for(const sp of specs) if(physics.attachCollider(this.prop, { ...sp, friction: fr, restitution: 0.05, groups, hitEvents: true })) n++;
        if(!n) physics.attachCollider(this.prop, { shape: 'sphere', radius: Math.max(0.1, Math.cbrt(st.volume * 0.24)), density: 1000, friction: fr, restitution: 0.05, groups, hitEvents: true });
        this.body.setMass(mass);
        this.colliderCount = this.prop.colliders.length;
    }

    /** Collision groups: bit 1 for every voxel body, a sibling bit (2..13) for fresh fracture pieces; while waiting
     *  for the terrain to be remeshed the terrain (bit 0) is filtered out. */
    groups() {
        if(!this.waitKeys && !this.sibling) return GROUPS_ALL;
        const member = 0x0002 | this.sibling;
        const filter = 0xffff & ~(this.waitKeys ? 0x0001 : 0) & ~this.sibling;
        return ((member << 16) | filter) >>> 0;
    }
    applyGroups() { const g = this.groups(); for(const c of this.prop.colliders) c.setCollisionGroups(g); }
    /** Collide with the terrain again (its chunks no longer contain this piece). */
    touchTerrain() { this.waitKeys = null; this.applyGroups(); }
    /** Collide with sibling pieces again. */
    touchSiblings() { this.sibling = 0; this.applyGroups(); }

    /** Enable a body created with enabled: false, at a pose (origin = world position of grid-local 0). */
    activate({ origin, rotation, linvel, angvel }) {
        const b = this.body;
        _q.set(rotation[0], rotation[1], rotation[2], rotation[3]);
        _v.set(this.frame[0], this.frame[1], this.frame[2]).applyQuaternion(_q);
        b.setEnabled(true);
        b.setTranslation({ x: origin[0] + _v.x, y: origin[1] + _v.y, z: origin[2] + _v.z }, false);
        b.setRotation({ x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] }, false);
        b.setLinvel({ x: linvel[0], y: linvel[1], z: linvel[2] }, true);
        b.setAngvel({ x: angvel[0], y: angvel[1], z: angvel[2] }, true);
        this.prevV = [...linvel];
        this.prop._prev = null; // no interpolation from where it was parked
        this.group.position.set(origin[0] + _v.x, origin[1] + _v.y, origin[2] + _v.z);
        this.group.quaternion.copy(_q);
        this.group.visible = true;
    }

    /** Mesh the grid in the worker pool; resolves when the mesh is in the scene. */
    remesh() {
        const v = ++this.version;
        const g = this.grid;
        return this.mgr.pool.meshGrid(g.sdf, g.mat, [g.nx, g.ny, g.nz]).then(mesh => {
            if(this.dead || v !== this.version) return;
            if(!mesh || !mesh.indices.length) { if(this.mesh) this.mesh.visible = false; return; }
            const geo = geometryFromMesh(mesh);
            if(this.mesh) { this.mesh.geometry.dispose(); this.mesh.geometry = geo; this.mesh.material = meshMaterial(this.mgr.material, geo); this.mesh.visible = true; }
            else {
                this.mesh = new THREE.Mesh(geo, meshMaterial(this.mgr.material, geo));
                this.mesh.position.set(-this.frame[0], -this.frame[1], -this.frame[2]);
                this.mesh.castShadow = true; this.mesh.receiveShadow = true;
                this.mesh.userData.voxelBody = this;
                this.group.add(this.mesh);
            }
        });
    }

    /** The body's rotation as [x,y,z,w]. */
    rotation() { const r = this.body.rotation(); return [r.x, r.y, r.z, r.w]; }
    /** World position of grid-local 0. */
    gridOrigin() {
        const t = this.body.translation(), r = this.body.rotation();
        _q.set(r.x, r.y, r.z, r.w);
        _v.set(-this.frame[0], -this.frame[1], -this.frame[2]).applyQuaternion(_q);
        return [t.x + _v.x, t.y + _v.y, t.z + _v.z];
    }
    /** World point -> grid-local metres. */
    toLocal(p) {
        const t = this.body.translation(), r = this.body.rotation();
        _q.set(-r.x, -r.y, -r.z, r.w);
        _v.set(p[0] - t.x, p[1] - t.y, p[2] - t.z).applyQuaternion(_q);
        return [_v.x + this.frame[0], _v.y + this.frame[1], _v.z + this.frame[2]];
    }
    /** Grid-local metres -> world point. */
    toWorld(l) {
        const t = this.body.translation(), r = this.body.rotation();
        _q.set(r.x, r.y, r.z, r.w);
        _v.set(l[0] - this.frame[0], l[1] - this.frame[1], l[2] - this.frame[2]).applyQuaternion(_q);
        return [t.x + _v.x, t.y + _v.y, t.z + _v.z];
    }
    /** World AABB of the grid's box: [min, max]. */
    worldBox() {
        const g = this.grid, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        const hi = [g.nx * VOXEL, g.ny * VOXEL, g.nz * VOXEL];
        for(let k = 0; k < 8; k++) {
            const w = this.toWorld([k & 1 ? hi[0] : -VOXEL, k & 2 ? hi[1] : -VOXEL, k & 4 ? hi[2] : -VOXEL]);
            for(let a = 0; a < 3; a++) { if(w[a] < mn[a]) mn[a] = w[a]; if(w[a] > mx[a]) mx[a] = w[a]; }
        }
        return [mn, mx];
    }
    /** Radius of the piece around its centre (half the grid diagonal). */
    get radius() { const g = this.grid; return Math.hypot(g.nx, g.ny, g.nz) * VOXEL * 0.5; }

    /** Blast push: a velocity kick that fades with distance, applied off-centre so tall pieces topple. */
    explode(center, radius, strength) {
        const b = this.body;
        if(!b.isDynamic()) return;
        const c = b.worldCom();
        const dx = c.x - center[0], dy = c.y - center[1], dz = c.z - center[2];
        const d = Math.hypot(dx, dy, dz);
        const reach = Math.max(0, d - this.radius * 0.6); // a big piece is hit at its near side
        if(reach > radius) return;
        const fall = 1 - reach / radius;
        const scale = 1 / (1 + this.stats.volume / 30); // big pieces move less
        const dv = strength * fall * scale;
        const inv = 1 / Math.max(d, 0.3);
        const m = b.mass();
        const J = { x: dx * inv * dv * m, y: (dy * inv + 0.35) * dv * m, z: dz * inv * dv * m };
        // applied between the blast and the centre of mass: the side facing the blast is kicked hardest
        const k = Math.min(0.6, this.radius * 0.5 / Math.max(d, 0.5));
        b.applyImpulseAtPoint(J, { x: c.x - dx * k, y: c.y - dy * k, z: c.z - dz * k }, true);
        this.mgr.soft?.blast(this, center, radius, dv); // and it jiggles: the near side is pushed harder
        const v = b.linvel(); this.prevV = [v.x, v.y, v.z]; // a kick is not an impact
        if(this.stats.volume < 4) {
            const a = b.angvel(), s = strength * fall * 0.4;
            b.setAngvel({ x: a.x + (Math.random() - 0.5) * s, y: a.y + (Math.random() - 0.5) * s, z: a.z + (Math.random() - 0.5) * s }, true);
        }
    }

    /** Remove from physics and the scene. With keepMesh the group stays in the scene (caller removes it later). */
    dispose({ keepMesh = false } = {}) {
        if(this.dead) return;
        this.dead = true;
        this.mgr.soft?.stop(this);
        const { physics } = this.mgr;
        physics.removeBody(this.prop);
        if(keepMesh) { this.mgr.scene.add(this.group); return; }
        this.disposeMesh();
    }
    disposeMesh() {
        this.mgr.soft?.release(this);
        this.group.removeFromParent();
        if(this.mesh) { this.mesh.geometry.dispose(); this.mesh = null; }
    }
}
