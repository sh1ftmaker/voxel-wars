/**
 * Destruction effects, pooled and instanced (one draw call per kind): rock chips (bouncing on the voxel SDF, coloured
 * by the material that broke, varied a little), dust puffs, fireballs and a single reused flash light. Driven by
 * ctx.events 'destroyed' / 'impact' / 'detached' and the game's explosion, shatter, dig, build and damage events.
 * Also shakes the player's camera by distance to blasts.
 */
import * as THREE from 'three/webgpu';
import { MATERIALS } from '../voxel/materials.js';

const GRAV = 30;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _c = new THREE.Color(), _e = new THREE.Euler();

/** A pool of instances of one geometry, each with position, velocity, life and a per-frame updater. */
class Pool {
    constructor(scene, geo, mat, cap, { shadows = false } = {}) {
        this.mesh = new THREE.InstancedMesh(geo, mat, cap);
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
        this.mesh.count = 0;
        this.mesh.frustumCulled = false;
        this.mesh.castShadow = shadows;
        scene.add(this.mesh);
        this.cap = cap;
        this.n = 0;
        // structure of arrays
        this.pos = new Float32Array(cap * 3); this.vel = new Float32Array(cap * 3);
        this.rot = new Float32Array(cap * 3); this.spin = new Float32Array(cap * 3);
        this.size = new Float32Array(cap); this.life = new Float32Array(cap); this.max = new Float32Array(cap);
        this.col = new Float32Array(cap * 3); this.rest = new Uint8Array(cap);
        this.vec3s = [this.pos, this.vel, this.rot, this.spin, this.col];
    }
    add(p, v, size, life, color) {
        let i = this.n;
        if(i >= this.cap) i = Math.floor(Math.random() * this.cap); // full: recycle a random one
        else this.n++;
        this.pos.set(p, i * 3); this.vel.set(v, i * 3);
        this.rot[i * 3] = Math.random() * 6; this.rot[i * 3 + 1] = Math.random() * 6; this.rot[i * 3 + 2] = Math.random() * 6;
        this.spin[i * 3] = (Math.random() - 0.5) * 14; this.spin[i * 3 + 1] = (Math.random() - 0.5) * 14; this.spin[i * 3 + 2] = (Math.random() - 0.5) * 14;
        this.size[i] = size; this.life[i] = life; this.max[i] = life; this.rest[i] = 0;
        this.col[i * 3] = color.r; this.col[i * 3 + 1] = color.g; this.col[i * 3 + 2] = color.b;
        return i;
    }
    kill(i) {
        const j = --this.n;
        if(i === j) return;
        for(const a of this.vec3s) { a[i * 3] = a[j * 3]; a[i * 3 + 1] = a[j * 3 + 1]; a[i * 3 + 2] = a[j * 3 + 2]; }
        this.size[i] = this.size[j]; this.life[i] = this.life[j]; this.max[i] = this.max[j]; this.rest[i] = this.rest[j];
    }
    flush(scaleOf, colorOf) {
        const m = this.mesh;
        if(this.n === 0 && m.count === 0) return;
        for(let i = 0; i < this.n; i++) {
            const s = scaleOf(i);
            _e.set(this.rot[i * 3], this.rot[i * 3 + 1], this.rot[i * 3 + 2]);
            _q.setFromEuler(_e);
            _m.compose(_p.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]), _q, _s.set(s, s, s));
            m.setMatrixAt(i, _m);
            colorOf.call(this, i, _c);
            m.setColorAt(i, _c);
        }
        m.count = this.n;
        m.instanceMatrix.needsUpdate = true;
        if(m.instanceColor) m.instanceColor.needsUpdate = true;
    }
}

export class Fx {
    constructor(game) {
        this.game = game;
        const ctx = this.ctx = game.ctx;
        const chipGeo = new THREE.DodecahedronGeometry(1, 0);
        this.chips = new Pool(ctx.scene, chipGeo, new THREE.MeshStandardNodeMaterial({ roughness: 0.9, flatShading: true }), 900, { shadows: false });
        this.dust = new Pool(ctx.scene, new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardNodeMaterial({ roughness: 1, transparent: true, opacity: 0.42, depthWrite: false }), 400);
        this.fire = new Pool(ctx.scene, new THREE.IcosahedronGeometry(1, 2), new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), 80);
        this.light = new THREE.PointLight(0xffa040, 0, 40, 1.6);
        ctx.scene.add(this.light);
        this.lightT = 0;
        this._tp = [0, 0, 0]; this._tv = [0, 0, 0];
        // per-instance size and colour functions, made once (flush runs every frame)
        const C = this.chips, D = this.dust, F = this.fire;
        this.chipScale = (i) => C.size[i] * Math.min(1, C.life[i] / 0.5);
        this.dustScale = (i) => { const t = 1 - D.life[i] / D.max[i]; return D.size[i] * (0.6 + t * 1.2) * Math.min(1, D.life[i] / (D.max[i] * 0.4)); };
        this.fireScale = (i) => { const t = 1 - F.life[i] / F.max[i]; return F.size[i] * (0.5 + t * 0.9); };
        this.plainColor = function(i, c) { c.setRGB(this.col[i * 3], this.col[i * 3 + 1], this.col[i * 3 + 2]); };
        this.fireColor = (i, c) => { const t = F.life[i] / F.max[i]; c.setRGB(F.col[i * 3] * t, F.col[i * 3 + 1] * t * t, F.col[i * 3 + 2] * t * t * t); };
        this.matColors = MATERIALS.map(m => new THREE.Color(m.color));
        this.hook();
    }
    /** A material's colour, randomly lighter or darker so a pile of chips reads as rock. */
    tint(mat, out = new THREE.Color()) {
        out.copy(this.matColors[mat] || this.matColors[1]);
        const k = 0.75 + Math.random() * 0.45;
        return out.multiplyScalar(k);
    }
    /** Chips flying out of `center` (spread over `box` if given), mats picked weighted by `removed`. */
    burst(center, { count = 10, speed = 8, size = 0.12, mats = [1], weights = null, box = null, up = 4, dust = 3, dustColor = null, dir = null } = {}) {
        const total = weights ? weights.reduce((a, b) => a + b, 0) : 0;
        for(let i = 0; i < count; i++) {
            let mat = mats[0];
            if(weights && total > 0) { let r = Math.random() * total; for(let k = 0; k < mats.length; k++) { r -= weights[k]; if(r <= 0) { mat = mats[k]; break; } } }
            else mat = mats[Math.floor(Math.random() * mats.length)];
            const p = box ? [box[0][0] + Math.random() * (box[1][0] - box[0][0]), box[0][1] + Math.random() * (box[1][1] - box[0][1]), box[0][2] + Math.random() * (box[1][2] - box[0][2])]
                : [center[0] + (Math.random() - 0.5) * 0.6, center[1] + (Math.random() - 0.5) * 0.6, center[2] + (Math.random() - 0.5) * 0.6];
            let dx = p[0] - center[0] + (Math.random() - 0.5) * 0.8, dy = p[1] - center[1] + Math.random() * 0.5, dz = p[2] - center[2] + (Math.random() - 0.5) * 0.8;
            if(dir) { dx += dir[0] * 1.5; dy += dir[1] * 1.5; dz += dir[2] * 1.5; }
            const l = Math.hypot(dx, dy, dz) || 1, s = speed * (0.4 + Math.random() * 0.8);
            this.chips.add(p, [dx / l * s, dy / l * s + up * Math.random(), dz / l * s], size * (0.5 + Math.random()), 1.6 + Math.random() * 1.4, this.tint(mat, _c));
        }
        for(let i = 0; i < dust; i++) {
            const col = dustColor || this.tint(mats[0], _c).lerp(new THREE.Color(0xd8d0c0), 0.5);
            const p = [center[0] + (Math.random() - 0.5) * 1.2, center[1] + (Math.random() - 0.3) * 0.8, center[2] + (Math.random() - 0.5) * 1.2];
            this.dust.add(p, [(Math.random() - 0.5) * 2.5, 0.6 + Math.random() * 1.4, (Math.random() - 0.5) * 2.5], 0.35 + Math.random() * 0.5 + size, 1.2 + Math.random() * 1.2, col);
        }
    }
    trail(pos) {
        const p = this._tp, v = this._tv;
        p[0] = pos.x; p[1] = pos.y; p[2] = pos.z;
        v[0] = (Math.random() - 0.5) * 0.6; v[1] = 0.4; v[2] = (Math.random() - 0.5) * 0.6;
        this.dust.add(p, v, 0.12 + Math.random() * 0.08, 0.7, _c.setRGB(0.75, 0.75, 0.75));
        v[0] = v[1] = v[2] = 0;
        if(Math.random() < 0.6) this.fire.add(p, v, 0.12, 0.12, _c.setRGB(1, 0.6, 0.2));
    }
    explosion(center, radius, kind) {
        const n = Math.round(4 + radius * 2);
        for(let i = 0; i < n; i++) {
            const v = [(Math.random() - 0.5) * radius * 3, Math.random() * radius * 2.5, (Math.random() - 0.5) * radius * 3];
            this.fire.add([center[0] + v[0] * 0.1, center[1] + v[1] * 0.1, center[2] + v[2] * 0.1], v, radius * (0.35 + Math.random() * 0.3), 0.3 + Math.random() * 0.25, _c.setRGB(1, 0.55 + Math.random() * 0.3, 0.15));
        }
        for(let i = 0; i < n + 2; i++) {
            const g = 0.25 + Math.random() * 0.2;
            this.dust.add([center[0] + (Math.random() - 0.5) * radius, center[1] + Math.random() * radius * 0.6, center[2] + (Math.random() - 0.5) * radius],
                [(Math.random() - 0.5) * radius * 1.5, 1 + Math.random() * radius, (Math.random() - 0.5) * radius * 1.5], radius * (0.3 + Math.random() * 0.3), 1.6 + Math.random() * 1.5, _c.setRGB(g, g, g * 0.95));
        }
        this.light.position.set(center[0], center[1] + 0.5, center[2]);
        this.light.intensity = 60 * radius * radius;
        this.light.distance = radius * 8;
        this.lightT = 0.25;
        // camera shake by distance
        const cam = this.ctx.camera.position;
        const d = Math.hypot(cam.x - center[0], cam.y - center[1], cam.z - center[2]);
        const k = Math.min(0.9, radius * 0.9 / (d + 1.5));
        if(k > 0.03) this.game.player?.shake(k);
    }

    hook() {
        const g = this.game, ev = this.ctx.events;
        ev.addEventListener('destroyed', (e) => {
            const d = e.detail; if(!d || !(d.volume > 0)) return;
            const mats = [], weights = [];
            for(let i = 0; i < d.removed.length; i++) if(d.removed[i] > 0) { mats.push(i); weights.push(d.removed[i]); }
            if(!mats.length) return;
            const v = d.volume;
            const blast = d.kind === 'blast';
            const count = Math.round(Math.min(blast ? 70 : 28, 4 + v * (blast ? 4 : 6)));
            const inner = d.box ? [d.box[0].map((x, i) => (x * 2 + d.box[1][i]) / 3), d.box[1].map((x, i) => (x * 2 + d.box[0][i]) / 3)] : null;
            this.burst(d.center, { count, speed: blast ? 14 : 6, size: blast ? 0.16 : 0.1, mats, weights, box: inner, up: blast ? 8 : 4, dust: Math.round(Math.min(blast ? 14 : 6, 1 + v)) });
        });
        ev.addEventListener('impact', (e) => {
            const d = e.detail; if(!d || d.speed < 5) return;
            this.burst(d.point, { count: Math.min(10, Math.round(d.speed / 3)), speed: d.speed * 0.3, mats: [d.mat ?? 0], dust: 2, size: 0.08 });
        });
        g.on('explosion', ({ center, radius, kind }) => this.explosion(center, kind === 'rock' ? radius * 0.6 : radius, kind));
        g.on('shatter', ({ point, mat, volume }) => this.burst(point, { count: Math.min(60, 20 + Math.round(volume * 15)), speed: 12, size: 0.16, mats: [mat], up: 6, dust: 6 }));
        g.on('slam', ({ point, mat }) => this.burst(point, { count: 12, speed: 6, size: 0.12, mats: [mat], up: 4, dust: 5 }));
        g.on('rip', ({ point, mat }) => { if(point) this.burst(point, { count: 14, speed: 5, size: 0.1, mats: [mat], up: 5, dust: 4 }); });
        g.on('punch', ({ point, kind }) => { if(kind === 'prop' || kind === 'actor') this.burst(point, { count: 5, speed: 5, size: 0.06, mats: [kind === 'actor' ? 7 : 10], dust: 1 }); });
        g.on('build', ({ center, size }) => this.burst([center[0], center[1] - size[1] / 2, center[2]], { count: 6, speed: 3, size: 0.08, mats: [8], dust: 6 }));
        g.on('damage', ({ actor }) => { if(!actor.isPlayer) { const c = actor.body.center; this.burst([c.x, c.y + 0.3, c.z], { count: 6, speed: 6, size: 0.07, mats: [7], dust: 0 }); } });
        g.on('deposit', ({ crate }) => { const t = crate.prop.body.translation(); for(let i = 0; i < 24; i++) this.fire.add([t.x, t.y + 0.5, t.z], [(Math.random() - 0.5) * 6, 4 + Math.random() * 6, (Math.random() - 0.5) * 6], 0.08, 0.9, _c.setRGB(1, 0.85, 0.3)); });
    }

    update(dt) {
        const w = this.ctx.world;
        // chips: ballistic, bounce on the terrain's SDF, settle, then shrink away
        const C = this.chips;
        for(let i = C.n - 1; i >= 0; i--) {
            C.life[i] -= dt;
            if(C.life[i] <= 0) { C.kill(i); continue; }
            const o = i * 3;
            if(!C.rest[i]) {
                C.vel[o + 1] -= GRAV * dt;
                const nx = C.pos[o] + C.vel[o] * dt, ny = C.pos[o + 1] + C.vel[o + 1] * dt, nz = C.pos[o + 2] + C.vel[o + 2] * dt;
                if(w.sample(nx, ny, nz) < C.size[i] * 0.3) {
                    // bounce: mostly upward, lose most of the speed
                    const sp = Math.hypot(C.vel[o], C.vel[o + 1], C.vel[o + 2]);
                    if(sp < 2.5) { C.rest[i] = 1; C.life[i] = Math.min(C.life[i], 1.2 + Math.random()); }
                    C.vel[o] *= 0.45; C.vel[o + 2] *= 0.45; C.vel[o + 1] = Math.abs(C.vel[o + 1]) * 0.3;
                    C.spin[o] *= 0.5; C.spin[o + 1] *= 0.5; C.spin[o + 2] *= 0.5;
                } else { C.pos[o] = nx; C.pos[o + 1] = ny; C.pos[o + 2] = nz; }
                C.rot[o] += C.spin[o] * dt; C.rot[o + 1] += C.spin[o + 1] * dt; C.rot[o + 2] += C.spin[o + 2] * dt;
            }
        }
        C.flush(this.chipScale, this.plainColor);
        // dust: drifts up, grows, then shrinks
        const D = this.dust;
        for(let i = D.n - 1; i >= 0; i--) {
            D.life[i] -= dt;
            if(D.life[i] <= 0) { D.kill(i); continue; }
            const o = i * 3, k = Math.max(0, 1 - dt * 1.5);
            D.vel[o] *= k; D.vel[o + 1] = D.vel[o + 1] * k + dt * 0.4; D.vel[o + 2] *= k;
            D.pos[o] += D.vel[o] * dt; D.pos[o + 1] += D.vel[o + 1] * dt; D.pos[o + 2] += D.vel[o + 2] * dt;
            D.rot[o + 1] += dt * 0.3;
        }
        D.flush(this.dustScale, this.plainColor);
        // fireballs: expand, cool from yellow to red to nothing (additive: darker = more transparent)
        const F = this.fire;
        for(let i = F.n - 1; i >= 0; i--) {
            F.life[i] -= dt;
            if(F.life[i] <= 0) { F.kill(i); continue; }
            const o = i * 3, k = Math.max(0, 1 - dt * 4);
            F.vel[o] *= k; F.vel[o + 1] *= k; F.vel[o + 2] *= k;
            F.pos[o] += F.vel[o] * dt; F.pos[o + 1] += F.vel[o + 1] * dt; F.pos[o + 2] += F.vel[o + 2] * dt;
        }
        F.flush(this.fireScale, this.fireColor);
        if(this.lightT > 0) { this.lightT -= dt; this.light.intensity *= Math.max(0, 1 - dt * 12); if(this.lightT <= 0) this.light.intensity = 0; }
    }
}
