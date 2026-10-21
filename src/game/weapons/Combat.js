/**
 * The mechanics every weapon shares, used by the player's tools and by the bots alike: explosions (crater, knockback,
 * damage), rockets (integrated projectiles), fused bodies (grenade, bunker buster), punching, digging, building,
 * ripping terrain out and throwing it. All matter changes go through ctx.destruction.
 *
 * Game events emitted (game.emit): 'explosion' { center, radius, kind, owner }, 'rocket' { origin, owner },
 * 'punch' { point, kind: 'terrain'|'prop'|'actor'|'air', mat }, 'dig' { point, volume }, 'build' { center, size },
 * 'rip' { prop }, 'throw' { kind, owner }, 'slam' { point, mat, volume, speed } (a thrown rock lands its hit),
 * 'bounce' { kind, point, impact }.
 */
import * as THREE from 'three/webgpu';
import { rock, capsule, box } from '../../voxel/brushes.js';
import { MATERIALS } from '../../voxel/materials.js';
import { WEAPONS, SELF_DAMAGE_SCALE, BOT_DAMAGE_SCALE } from './defs.js';
import { BodyType } from '../../physics/Physics.js';

const _v = new THREE.Vector3();
/** m/s added each frame to the ground under a lump being torn out (src/soft: SoftGround.pull). */
const RIP_PULL = 1.6;
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export class Combat {
    constructor(game) {
        this.game = game;
        this.ctx = game.ctx;
        this.rockets = [];
        this.fused = [];     // { prop, kind, owner, at, born, lastBounce }
        this.thrown = [];    // { prop, owner, born, prevV: [x,y,z], radius }
        this.seed = 11;
        const geo = new THREE.CylinderGeometry(0.07, 0.11, 0.6, 8); geo.rotateX(Math.PI / 2);
        this.rocketGeo = geo;
        this.rocketMat = new THREE.MeshStandardNodeMaterial({ color: 0x40464f, emissive: 0xff7a20, emissiveIntensity: 0.6, roughness: 0.5 });
        this.grenadeMat = new THREE.MeshStandardNodeMaterial({ color: 0x2f3a2a, roughness: 0.6, metalness: 0.3, emissive: 0xff2010, emissiveIntensity: 0 });
        this.busterMat = new THREE.MeshStandardNodeMaterial({ color: 0xe0b020, roughness: 0.5, metalness: 0.4, emissive: 0xff3010, emissiveIntensity: 0 });
        this.rockMats = new Map();
        ctx_events(this);
    }

    // ---- queries ----
    /** Ray against terrain colliders, bodies and actors, skipping the owner's capsule and whatever it holds. */
    raycast(origin, dir, maxDist, owner = null) {
        const physics = this.ctx.physics;
        const hit = physics.raycast(origin, dir, maxDist, { ignore: owner ? owner.ignoreHandles() : null });
        if(!hit) return null;
        const actor = this.game.actorByCollider.get(hit.collider?.handle) || null;
        return { point: hit.point, normal: hit.normal, distance: hit.distance, collider: hit.collider, actor, prop: actor ? null : hit.prop };
    }

    // ---- explosions ----
    explode(center, kind, owner, def = WEAPONS[kind]) {
        const R = def.radius, reach = R * 1.6;
        this.ctx.destruction.blast(center, R, { strength: def.knock * 0.9, author: owner?.name ?? null, seed: this.seed++ });
        for(const a of this.game.actors) {
            if(!a.alive) continue;
            const c = a.body.center;
            const d = Math.hypot(c.x - center[0], c.y - center[1], c.z - center[2]);
            if(d > reach + 0.8) continue;
            const f = Math.max(0, Math.min(1, 1 - (d - 0.8) / reach));
            const dir = d > 1e-3 ? [(c.x - center[0]) / d, (c.y - center[1]) / d, (c.z - center[2]) / d] : [0, 1, 0];
            const k = def.knock * f;
            const self = a === owner ? 1.5 : 1; // rocket jumps should fly
            const impulse = [dir[0] * k * self, Math.max(dir[1], 0.35) * k * 1.15 * self, dir[2] * k * self];
            let dmg = def.damage * f;
            if(a === owner) dmg *= SELF_DAMAGE_SCALE;
            else if(owner && !owner.isPlayer && a.isPlayer) dmg *= BOT_DAMAGE_SCALE;
            if(owner && a !== owner && owner.team === a.team) dmg = 0; // no friendly fire (knockback still applies)
            this.game.damage(a, dmg, owner, impulse, kind);
        }
        this.game.emit('explosion', { center, radius: R, kind, owner });
    }

    // ---- rockets ----
    fireRocket(owner, origin, dir) {
        const def = WEAPONS.rocket;
        // point blank: born inside the wall ahead it would fly through it
        const pre = this.raycast(origin, dir, 1.2, owner);
        this.game.emit('rocket', { origin, owner });
        if(pre) {
            if(pre.actor) this.game.damage(pre.actor, def.direct * (owner.isPlayer ? 1 : BOT_DAMAGE_SCALE), owner, [dir[0] * 4, 2, dir[2] * 4], 'rocket');
            this.explode([pre.point[0] - dir[0] * 0.15, pre.point[1] - dir[1] * 0.15, pre.point[2] - dir[2] * 0.15], 'rocket', owner);
            return;
        }
        const mesh = new THREE.Mesh(this.rocketGeo, this.rocketMat);
        mesh.position.set(origin[0] + dir[0] * 1.2, origin[1] + dir[1] * 1.2, origin[2] + dir[2] * 1.2);
        this.ctx.scene.add(mesh);
        this.rockets.push({ pos: mesh.position, vel: new THREE.Vector3(dir[0] * def.speed, dir[1] * def.speed, dir[2] * def.speed), owner, age: 0, mesh, trail: 0 });
    }

    updateRockets(dt) {
        const def = WEAPONS.rocket;
        for(let i = this.rockets.length - 1; i >= 0; i--) {
            const r = this.rockets[i];
            r.age += dt;
            r.vel.y -= def.gravity * dt;
            const step = _v.copy(r.vel).multiplyScalar(dt);
            const len = step.length();
            const dir = this._rd ??= [0, 0, 0], o = this._ro ??= [0, 0, 0];
            dir[0] = step.x / len; dir[1] = step.y / len; dir[2] = step.z / len;
            o[0] = r.pos.x; o[1] = r.pos.y; o[2] = r.pos.z;
            const hit = this.raycast(o, dir, len + 0.2, r.age < 0.25 ? r.owner : null);
            let at = null;
            if(hit) {
                if(hit.actor && hit.actor !== r.owner && hit.actor.team !== r.owner?.team) this.game.damage(hit.actor, def.direct * (r.owner?.isPlayer ? 1 : BOT_DAMAGE_SCALE), r.owner, [dir[0] * 4, 2, dir[2] * 4], 'rocket');
                at = [hit.point[0] - dir[0] * 0.15, hit.point[1] - dir[1] * 0.15, hit.point[2] - dir[2] * 0.15];
            } else if(r.age > def.life || r.pos.y < -30) { this.removeRocket(i); continue; }
            if(at) { this.removeRocket(i); this.explode(at, 'rocket', r.owner); continue; }
            r.pos.add(step);
            r.mesh.lookAt(r.pos.x + step.x, r.pos.y + step.y, r.pos.z + step.z);
            r.trail -= dt;
            if(r.trail <= 0) { r.trail = 0.025; this.game.fx?.trail(r.pos); }
        }
    }
    removeRocket(i) { const r = this.rockets[i]; r.mesh.removeFromParent(); this.rockets.splice(i, 1); }

    // ---- fused bodies ----
    throwFused(owner, kind, origin, dir, speed) {
        const def = WEAPONS[kind];
        const r = kind === 'buster' ? 0.42 : 0.2;
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), kind === 'buster' ? this.busterMat.clone() : this.grenadeMat.clone());
        mesh.castShadow = true;
        if(kind === 'buster') { const band = new THREE.Mesh(new THREE.TorusGeometry(r * 1.02, r * 0.18, 6, 16), new THREE.MeshStandardNodeMaterial({ color: 0x222222 })); mesh.add(band); }
        const start = [origin[0] + dir[0] * 0.9, origin[1] + dir[1] * 0.9 - 0.15, origin[2] + dir[2] * 0.9];
        const ov = owner?.body?.vel ?? { x: 0, y: 0, z: 0 };
        const prop = this.ctx.physics.addBody({ shape: 'sphere', size: r, position: start, mesh,
            velocity: [dir[0] * speed + ov.x * 0.5, dir[1] * speed + 2.5, dir[2] * speed + ov.z * 0.5],
            angularVelocity: [Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4],
            density: kind === 'buster' ? 3000 : 2500, restitution: kind === 'buster' ? 0.15 : 0.45, friction: 0.6, userData: { kind } });
        owner?.ignoreTemp?.(prop.collider.handle, 0.3);
        this.fused.push({ prop, kind, owner, at: def.fuse, age: 0, prevV: [0, 0, 0], tick: 0 });
        this.game.emit('throw', { kind, owner });
        return prop;
    }
    updateFused(dt) {
        for(let i = this.fused.length - 1; i >= 0; i--) {
            const f = this.fused[i];
            f.age += dt;
            const b = f.prop.body;
            const t = b.translation(), v = b.linvel();
            const dv = Math.hypot(v.x - f.prevV[0], v.y - f.prevV[1], v.z - f.prevV[2]);
            if(dv > 4 && f.age > 0.1) this.game.emit('bounce', { kind: f.kind, point: [t.x, t.y, t.z], impact: Math.min(1, dv / 15) });
            f.prevV[0] = v.x; f.prevV[1] = v.y; f.prevV[2] = v.z;
            // blink faster as the fuse burns down
            const prog = f.age / f.at;
            f.tick -= dt;
            if(f.tick <= 0) { f.tick = Math.max(0.08, 0.5 * (1 - prog)); f.prop.mesh.material.emissiveIntensity = 2.5; this.game.emit('fuse', { kind: f.kind, progress: prog, point: [t.x, t.y, t.z] }); }
            else f.prop.mesh.material.emissiveIntensity *= 0.85;
            if(f.age >= f.at || t.y < -30) {
                this.fused.splice(i, 1);
                this.ctx.physics.removeBody(f.prop);
                f.prop.mesh.geometry.dispose();
                if(t.y > -30) this.explode([t.x, t.y, t.z], f.kind, f.owner);
            }
        }
    }

    // ---- melee ----
    punch(owner, origin, dir) {
        const def = WEAPONS.punch;
        const hit = this.raycast(origin, dir, def.reach, owner);
        if(!hit) { this.game.emit('punch', { point: [origin[0] + dir[0] * 2, origin[1] + dir[1] * 2, origin[2] + dir[2] * 2], kind: 'air', owner }); return 'air'; }
        if(hit.actor) {
            const a = hit.actor;
            if(a.team !== owner.team) this.game.damage(a, def.damage * (owner.isPlayer ? 1 : BOT_DAMAGE_SCALE), owner, [dir[0] * def.knock, 6, dir[2] * def.knock], 'punch');
            else a.body.knock([dir[0] * def.knock * 0.5, 4, dir[2] * def.knock * 0.5]);
            this.game.emit('punch', { point: hit.point, kind: 'actor', owner });
            return 'actor';
        }
        if(hit.prop) {
            const b = hit.prop.body;
            if(b.isDynamic()) {
                const m = b.mass(), s = def.propSpeed * Math.min(1, 60 / Math.max(m, 1)) + 4;
                b.applyImpulse({ x: dir[0] * s * m, y: (dir[1] + 0.35) * s * m, z: dir[2] * s * m }, true);
                b.applyTorqueImpulse({ x: (Math.random() - 0.5) * m, y: (Math.random() - 0.5) * m, z: (Math.random() - 0.5) * m }, true);
                // a voxel body's soft layer: the far side lags behind the fist (a jiggle at least as big as a 6 m/s hit)
                const vb = hit.prop.userData?.voxelBody, k = Math.max(s, 6);
                if(vb) this.ctx.destruction.bodies?.soft?.impact(vb, hit.point, [dir[0] * k, (dir[1] + 0.35) * k, dir[2] * k], 1);
            }
            this.game.emit('punch', { point: hit.point, kind: 'prop', owner, mat: hit.prop.userData?.mat ?? 10 });
            return 'prop';
        }
        // terrain: bite a rock-shaped chunk out just past the surface
        const p = hit.point;
        const c = [p[0] + dir[0] * 0.35, p[1] + dir[1] * 0.35, p[2] + dir[2] * 0.35];
        const mat = this.ctx.world.materialAt(p[0] + dir[0] * 0.1, p[1] + dir[1] * 0.1, p[2] + dir[2] * 0.1);
        const res = this.ctx.destruction.carve(rock(c, def.radius, this.seed++), { author: owner?.name ?? null, impulse: 5, kind: 'carve', dir });
        // the terrain edit runs in the terrain worker: the stone counts once it is done
        res.done.then(r => owner?.addStone?.(r.volume));
        this.game.emit('punch', { point: p, kind: 'terrain', owner, mat, volume: res.volume });
        return 'terrain';
    }

    // ---- drill ----
    dig(owner, dir) {
        const def = WEAPONS.drill, r = def.radius, f = owner.body.feet;
        const a = [f.x, f.y + r - def.sink, f.z];
        const b = [a[0] + dir[0] * def.reach, a[1] + dir[1] * def.reach, a[2] + dir[2] * def.reach];
        const res = this.ctx.destruction.carve(capsule(a, b, r), { author: owner?.name ?? null, kind: 'carve' });
        // (asynchronous with the terrain worker: the volume is known a frame or two later; bots read the last dig's)
        if(owner) res.done.then(r => { owner.addStone?.(r.volume); owner.lastDigVolume = r.volume; });
        const front = [a[0] + dir[0] * (def.reach + r * 0.8), a[1] + dir[1] * (def.reach + r * 0.8), a[2] + dir[2] * (def.reach + r * 0.8)];
        this.game.emit('dig', { point: front, volume: res.volume, owner });
        return res.pending ? (owner?.lastDigVolume ?? 1) : res.volume;
    }

    // ---- mason ----
    /** Add a box of the owner's team stone; returns the volume added (0 if refused). */
    build(owner, min, max, mat) {
        for(const a of this.game.actors) {
            if(!a.alive) continue;
            const c = a.body.center, rr = a.body.radius + 0.05, hh = a.body.halfHeight + a.body.radius;
            if(c.x + rr > min[0] && c.x - rr < max[0] && c.z + rr > min[2] && c.z - rr < max[2] && c.y + hh > min[1] && c.y - hh < max[1]) return 0;
        }
        const res = this.ctx.destruction.carve(box(min, max, 0.06), { op: 'add', mat, author: owner?.name ?? null, kind: 'build' });
        const center = min.map((v, i) => (v + max[i]) / 2);
        this.game.emit('build', { center, size: max.map((v, i) => v - min[i]), owner });
        return Math.max(res.added, 0.01);
    }

    // ---- grab & throw ----
    rockMaterial(mat) {
        let m = this.rockMats.get(mat);
        if(!m) { m = new THREE.MeshStandardNodeMaterial({ color: MATERIALS[mat]?.color ?? 0x888888, roughness: 0.9, flatShading: true }); this.rockMats.set(mat, m); }
        return m;
    }
    /** Rip a lump out of the terrain (or grab a loose body) in front of the owner at once (bots). Returns a held prop
     *  or null. The player tears it out over a moment instead: startRip, pullRip each frame, finishRip. */
    rip(owner, origin, dir) {
        const r = this.startRip(owner, origin, dir);
        if(!r) return null;
        return r.prop || this.finishRip(owner, r, [0, 1, 0]);
    }
    /**
     * Take hold of what is in front of the owner: { prop } for a loose body, or a tear for the ground
     * { point, center, mat, g (soft ground handle or null), dur (s it holds on: harder matter longer) }; null for
     * nothing (or bedrock).
     */
    startRip(owner, origin, dir) {
        const def = WEAPONS.grab;
        const hit = this.raycast(origin, dir, def.reach, owner);
        if(!hit || hit.actor) return null;
        if(hit.prop) {
            const ud = hit.prop.userData || {};
            if(ud.crate || ud.kind) return null;   // crates are carried by walking into them, bombs are not toys
            return hit.prop.body.isDynamic() ? { prop: hit.prop } : null;
        }
        const p = hit.point;
        const c = [p[0] + dir[0] * 0.45, p[1] + dir[1] * 0.45, p[2] + dir[2] * 0.45];
        const mat = this.ctx.world.materialAt(p[0] + dir[0] * 0.1, p[1] + dir[1] * 0.1, p[2] + dir[2] * 0.1);
        const hard = MATERIALS[mat]?.hardness ?? 1;
        if(hard === Infinity) return null;
        const g = this.ctx.soft?.grab?.(c, def.radius) || null;
        return { point: p, center: c, mat, g, dur: g ? 0.14 + 0.07 * Math.min(6, hard) : 0 };
    }
    /** A frame of tearing: the soft ground is dragged along `dir` (toward the hand). */
    pullRip(tear, dir, dt) {
        if(tear.g) this.ctx.soft.pull(tear.g, dir, RIP_PULL * Math.min(2, dt * 60));
    }
    /** The ground lets go: the lump comes out as a body (null if there was nothing), the rim springs back. */
    finishRip(owner, tear, dir) {
        const def = WEAPONS.grab, { point: p, center: c, mat } = tear;
        let prop = null;
        try { prop = this.ctx.destruction.rip?.(c, def.radius, { author: owner?.name ?? null }) || null; } catch(e) { console.warn('rip failed', e); prop = null; }
        if(tear.g) this.ctx.soft.tear(tear.g, dir, 7);
        if(prop) {
            prop.userData ||= {}; prop.userData.mat ??= mat;
            if(tear.g) {
                // it comes out where the stretched ground drew it, still wobbling from the pull
                const t = prop.body.translation(), lift = 0.45;
                prop.body.setTranslation({ x: t.x + dir[0] * lift, y: t.y + dir[1] * lift, z: t.z + dir[2] * lift }, true);
                const vb = prop.userData.voxelBody;
                if(vb) this.ctx.destruction.bodies?.soft?.impact(vb, [c[0] - dir[0], c[1] - dir[1], c[2] - dir[2]], [dir[0] * 8, dir[1] * 8, dir[2] * 8], 1);
            }
            this.game.emit('rip', { prop, point: p, mat });
            return prop;
        }
        // no voxel body came out: carve a lump and make a boulder of what came out
        const res = this.ctx.destruction.carve(rock(c, def.radius, this.seed++), { author: owner?.name ?? null, kind: 'carve' });
        if(res.volume < 0.08) return null;
        let best = 1, bv = 0;
        for(let i = 0; i < res.removed.length; i++) if(res.removed[i] > bv) { bv = res.removed[i]; best = i; }
        const r = Math.max(0.35, Math.min(0.85, Math.cbrt(res.volume * 3 / (4 * Math.PI)) * 0.9));
        const geo = new THREE.DodecahedronGeometry(r, 0);
        const pos = geo.attributes.position; // knobbly: jitter vertices
        for(let i = 0; i < pos.count; i++) { const k = 0.8 + Math.random() * 0.35; pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k); }
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, this.rockMaterial(best));
        mesh.castShadow = true;
        prop = this.ctx.physics.addBody({ shape: 'sphere', size: r * 0.92, position: c, mesh, density: Math.min(2200, MATERIALS[best]?.density ?? 1600), friction: 0.8, restitution: 0.15, userData: { boulder: true, mat: best, volume: res.volume } });
        this.game.emit('rip', { prop, point: p, mat: best });
        return prop;
    }
    /** Hold: a kinematic body following `target`. */
    hold(prop, on) {
        const b = prop.body;
        b.setBodyType(on ? BodyType.Kinematic : BodyType.Dynamic, true);
        prop.userData ||= {};
        prop.userData.held = on; // VoxelBodies: a held body never settles or fractures
    }
    throwHeld(owner, prop, dir, speed) {
        this.hold(prop, false);
        const b = prop.body, ov = owner.body.vel;
        b.setBullet(true); // fast: continuous collision against other bodies too
        b.setLinvel({ x: dir[0] * speed + ov.x * 0.5, y: dir[1] * speed + 3, z: dir[2] * speed + ov.z * 0.5 }, true);
        // a forward end-over-end tumble (up x dir) with a little wobble, not a random spin on every axis
        const h = Math.hypot(dir[0], dir[2]) || 1, spin = 3 + Math.random() * 2, j = () => Math.random() - 0.5;
        b.setAngvel({ x: dir[2] / h * spin + j(), y: j(), z: -dir[0] / h * spin + j() }, true);
        owner?.ignoreTemp?.(prop.collider.handle, 0.35);
        // VoxelBodies: a thrown body cracks along its soft lattice when it hits hard, it never bursts into rubble
        prop.userData.thrown = true;
        this.thrown.push({ prop, owner, age: 0, prevV: [b.linvel().x, b.linvel().y, b.linvel().z] });
        this.game.emit('throw', { kind: 'rock', owner });
    }
    /** Drop a held body gently. */
    dropHeld(owner, prop) {
        this.hold(prop, false);
        const ov = owner.body.vel;
        prop.body.setLinvel({ x: ov.x, y: ov.y, z: ov.z }, true);
        owner?.ignoreTemp?.(prop.collider.handle, 0.4);
    }
    updateThrown(dt) {
        const def = WEAPONS.grab;
        for(let i = this.thrown.length - 1; i >= 0; i--) {
            const t = this.thrown[i];
            t.age += dt;
            if(!this.ctx.physics.props.has(t.prop)) { this.thrown.splice(i, 1); continue; } // cracked into pieces, settled or pulverized
            const b = t.prop.body, p = b.translation(), v = b.linvel();
            const dv = Math.hypot(v.x - t.prevV[0], v.y - t.prevV[1], v.z - t.prevV[2]);
            const speed = Math.hypot(t.prevV[0], t.prevV[1], t.prevV[2]);
            t.prevV[0] = v.x; t.prevV[1] = v.y; t.prevV[2] = v.z;
            if(!t.slammed) {
                let hit = t.slamAt || (t.age > 0.06 && dv > def.shatterSpeed && speed > def.shatterSpeed ? [p.x, p.y, p.z] : null);
                // a direct hit on an enemy
                if(!hit && speed > 8) for(const a of this.game.actors) {
                    if(!a.alive || a === t.owner || a.team === t.owner?.team) continue;
                    const c = a.body.center;
                    if(Math.abs(c.x - p.x) < 1.2 && Math.abs(c.z - p.z) < 1.2 && Math.abs(c.y - p.y) < 1.6) { hit = [p.x, p.y, p.z]; break; }
                }
                if(hit) { t.slammed = true; this.slam(t, hit, Math.max(speed, def.shatterSpeed)); }
            }
            if(t.age > 6 || (t.age > 0.5 && speed < 1.5)) this.thrown.splice(i, 1); // came to rest: plain rubble now
        }
    }
    /** A thrown lump lands its hit: whoever it strikes takes damage and knockback (no blast: the rock stays a body
     *  and cracks only if the hit was hard enough for its lattice). */
    slam(t, point, speed) {
        const def = WEAPONS.grab, vol = t.prop.userData?.volume ?? 1;
        const reach = 1.1 + Math.cbrt(vol) * 0.55, f0 = Math.min(1, speed / def.throwSpeed + 0.3);
        for(const a of this.game.actors) {
            if(!a.alive || a === t.owner) continue;
            const c = a.body.center;
            const d = Math.hypot(c.x - point[0], c.y - point[1], c.z - point[2]);
            if(d > reach + 0.6) continue;
            const f = f0 * Math.min(1, 1.2 - d / (reach + 0.6) * 0.6);
            const dir = d > 1e-3 ? [(c.x - point[0]) / d, (c.y - point[1]) / d, (c.z - point[2]) / d] : [0, 1, 0];
            let dmg = def.damage * f;
            if(t.owner && !t.owner.isPlayer && a.isPlayer) dmg *= BOT_DAMAGE_SCALE;
            if(t.owner && t.owner.team === a.team) dmg = 0;
            this.game.damage(a, dmg, t.owner, [dir[0] * def.knock * f, Math.max(dir[1], 0.4) * def.knock * f, dir[2] * def.knock * f], 'rock');
        }
        this.game.emit('slam', { point, mat: t.prop.userData?.mat ?? 1, volume: vol, speed });
    }

    update(dt) {
        this.updateRockets(dt);
        this.updateFused(dt);
        this.updateThrown(dt);
    }
}

/** 'impact' from physics: a thrown prop that hits hard lands its blow there. */
function ctx_events(combat) {
    combat.ctx.events.addEventListener('impact', (e) => {
        const d = e.detail; if(!d?.prop) return;
        const t = combat.thrown.find(t => t.prop === d.prop);
        if(t && t.age > 0.06 && d.speed > WEAPONS.grab.shatterSpeed * 0.7) t.slamAt = d.point; // handled in update (not inside the physics step)
    });
}
