/**
 * Destruction effects. Debris particles come from src/fx/Particles.js, per material: stone chips and a lingering dust
 * cloud, wood splinters along the grain, dirt clods, sand and snow puffs, metal sparks, glass slivers that twinkle.
 * Fireballs (pooled, instanced) and a single reused flash light are here. Driven by ctx.events 'destroyed' /
 * 'impact' / 'detached', the material-fracture events 'fracture' / 'splinters' / 'crumble' / 'bend' / 'chips' (from
 * ctx.events or the game), and the game's explosion, shatter, slam, rip, punch, build and damage events.
 * Also shakes the player's camera by distance to blasts.
 */
import * as THREE from 'three/webgpu';
import { Particles, particleKind, grainAxis, materialColor } from './Particles.js';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _c = new THREE.Color();
const R = Math.random;

/** A pool of instances of one geometry (fireballs), each with position, velocity, life. */
class Pool {
    constructor(scene, geo, mat, cap) {
        this.mesh = new THREE.InstancedMesh(geo, mat, cap);
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
        this.mesh.count = 0;
        this.mesh.frustumCulled = false;
        scene.add(this.mesh);
        this.cap = cap;
        this.n = 0;
        this.pos = new Float32Array(cap * 3); this.vel = new Float32Array(cap * 3);
        this.size = new Float32Array(cap); this.life = new Float32Array(cap); this.max = new Float32Array(cap);
        this.col = new Float32Array(cap * 3);
    }
    add(p, v, size, life, color) {
        let i = this.n;
        if(i >= this.cap) i = Math.floor(R() * this.cap);
        else this.n++;
        this.pos.set(p, i * 3); this.vel.set(v, i * 3);
        this.size[i] = size; this.life[i] = life; this.max[i] = life;
        this.col[i * 3] = color.r; this.col[i * 3 + 1] = color.g; this.col[i * 3 + 2] = color.b;
        return i;
    }
    kill(i) {
        const j = --this.n;
        if(i === j) return;
        for(const a of [this.pos, this.vel, this.col]) { a[i * 3] = a[j * 3]; a[i * 3 + 1] = a[j * 3 + 1]; a[i * 3 + 2] = a[j * 3 + 2]; }
        this.size[i] = this.size[j]; this.life[i] = this.life[j]; this.max[i] = this.max[j];
    }
    flush(scaleOf, colorOf) {
        const m = this.mesh;
        if(this.n === 0 && m.count === 0) return;
        for(let i = 0; i < this.n; i++) {
            const s = scaleOf(i);
            _m.compose(_p.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]), _q.identity(), _s.set(s, s, s));
            m.setMatrixAt(i, _m);
            colorOf(i, _c);
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
        this.parts = new Particles(ctx.scene, ctx.world);
        this.fire = new Pool(ctx.scene, new THREE.IcosahedronGeometry(1, 2), new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), 80);
        this.light = new THREE.PointLight(0xffa040, 0, 40, 1.6);
        ctx.scene.add(this.light);
        this.lightT = 0;
        const F = this.fire;
        this.fireScale = (i) => { const t = 1 - F.life[i] / F.max[i]; return F.size[i] * (0.5 + t * 0.9); };
        this.fireColor = (i, c) => { const t = F.life[i] / F.max[i]; c.setRGB(F.col[i * 3] * t, F.col[i * 3 + 1] * t * t, F.col[i * 3 + 2] * t * t * t); };
        this.colors = [];
        this.hook();
    }
    /** A material's colour as linear rgb (cached). */
    rgb(mat) {
        let c = this.colors[mat];
        if(!c) { const k = new THREE.Color(materialColor(mat)); c = this.colors[mat] = [k.r, k.g, k.b]; }
        return c;
    }

    /**
     * `count` pieces of material `mat` flying out of `center` (spread over `box` if given), each in the material's
     * look: chips, splinters along the grain, clods, puffs, sparks or glass slivers. `dir` biases the throw.
     */
    emit(mat, center, count, { speed = 8, size = 0.12, up = 4, box = null, dir = null, axis = null } = {}) {
        const P = this.parts, kind = particleKind(mat), [r, g, b] = this.rgb(mat);
        const ax = axis ?? grainAxis(mat);
        for(let i = 0; i < count; i++) {
            const x = box ? box[0][0] + R() * (box[1][0] - box[0][0]) : center[0] + (R() - 0.5) * 0.6;
            const y = box ? box[0][1] + R() * (box[1][1] - box[0][1]) : center[1] + (R() - 0.5) * 0.6;
            const z = box ? box[0][2] + R() * (box[1][2] - box[0][2]) : center[2] + (R() - 0.5) * 0.6;
            let dx = x - center[0] + (R() - 0.5) * 0.8, dy = y - center[1] + R() * 0.5, dz = z - center[2] + (R() - 0.5) * 0.8;
            if(dir) { dx += dir[0] * 1.5; dy += dir[1] * 1.5; dz += dir[2] * 1.5; }
            const l = Math.hypot(dx, dy, dz) || 1, s = speed * (0.4 + R() * 0.8);
            const vx = dx / l * s, vy = dy / l * s + up * R(), vz = dz / l * s;
            switch(kind) {
                case 'splinter': P.splinter(x, y, z, vx * 1.1, vy, vz * 1.1, size, ax, r, g, b); break;
                case 'clod': P.clod(x, y, z, vx * 0.7, vy * 0.8, vz * 0.7, size * 1.1, r, g, b); break;
                case 'puff':
                    // sand and snow: small grains, and every other one a soft puff
                    P.clod(x, y, z, vx * 0.5, vy * 0.6, vz * 0.5, size * 0.45, r, g, b);
                    if(i % 2 === 0) P.puff(x, y, z, vx * 0.3, vy * 0.2 + 0.4, vz * 0.3, 0.15 + size * 1.2 + R() * 0.2, 1 + R() * 1, r, g, b, { rise: 0.15, drag: 2.5, grow: 1.1, alpha: 0.8 });
                    break;
                case 'spark':
                    P.sparkle(x, y, z, vx * 1.6, vy * 1.3 + 2, vz * 1.6);
                    if(i % 4 === 0) P.chip(x, y, z, vx * 0.6, vy * 0.6, vz * 0.6, size * 0.5, r, g, b);
                    break;
                case 'glint': P.glint(x, y, z, vx, vy, vz, size * 1.2); break;
                default: P.chip(x, y, z, vx, vy, vz, size, r, g, b);
            }
        }
    }
    /** Dust puffs of a material's colour (paler); `linger` for the slow stone dust cloud that hangs after a break. */
    dust(mat, center, count, { size = 0.4, linger = false, spread = 1.2 } = {}) {
        const P = this.parts, [r, g, b] = this.rgb(mat), kind = particleKind(mat);
        if(kind === 'glint' || kind === 'spark') return; // no dust from glass or metal
        const pale = kind === 'puff' ? 0.15 : 0.5; // sand and snow keep their colour
        const cr = r + (0.85 - r) * pale, cg = g + (0.82 - g) * pale, cb = b + (0.76 - b) * pale;
        for(let i = 0; i < count; i++) {
            const x = center[0] + (R() - 0.5) * spread, y = center[1] + (R() - 0.3) * spread * 0.6, z = center[2] + (R() - 0.5) * spread;
            if(linger) P.puff(x, y, z, (R() - 0.5) * 1.2, 0.3 + R() * 0.6, (R() - 0.5) * 1.2, size * (1 + R()), 4 + R() * 3, cr, cg, cb, { rise: 0.15, drag: 0.9, grow: 2.2, alpha: 0.7 });
            else P.puff(x, y, z, (R() - 0.5) * 2.5, 0.6 + R() * 1.4, (R() - 0.5) * 2.5, size + R() * 0.5, 1.2 + R() * 1.2, cr, cg, cb);
        }
    }
    /** Debris flying out of `center` (spread over `box` if given), materials split by `weights` (m³ removed). */
    burst(center, { count = 10, speed = 8, size = 0.12, mats = [1], weights = null, box = null, up = 4, dust = 3, dir = null } = {}) {
        const total = weights ? weights.reduce((a, b) => a + b, 0) : 0;
        let main = mats[0], mainW = -1;
        for(let k = 0; k < mats.length; k++) {
            const share = weights && total > 0 ? weights[k] / total : 1 / mats.length;
            if(share > mainW) { mainW = share; main = mats[k]; }
            const want = count * share, n = Math.floor(want) + (R() < want % 1 ? 1 : 0);
            if(n > 0) this.emit(mats[k], center, n, { speed, size, up, box, dir });
        }
        if(dust > 0) this.dust(main, center, dust, { size: 0.35 + size });
    }
    /** A material breaking by its own rules (fracture events): splinters, a shatter with a hanging dust cloud, a
     *  crumble into clods and puffs, sparks from bending metal, glass slivers. */
    fracture(point, mat, { mode = null, energy = 1, pieces = 2, dir = null, axis = null } = {}) {
        const kind = particleKind(mat), e = Math.min(3, Math.max(0.3, energy));
        const m = mode || ({ splinter: 'splinter', clod: 'crumble', puff: 'crumble', spark: 'bend' })[kind] || 'shatter';
        if(m === 'splinter') {
            this.emit(mat, point, Math.round(10 + 10 * e), { speed: 7 + 3 * e, size: 0.1, up: 4, dir, axis });
            this.dust(mat, point, 2, { size: 0.3 });
        } else if(m === 'crumble') {
            this.emit(mat, point, Math.round(8 + 8 * e), { speed: 3 + 2 * e, size: 0.14, up: 2, dir });
            this.dust(mat, point, Math.round(3 + 3 * e), { size: 0.5 });
        } else if(m === 'bend') {
            this.emit(kind === 'spark' ? mat : 6, point, Math.round(6 + 10 * e), { speed: 6 + 4 * e, size: 0.08, up: 3, dir });
        } else {
            this.emit(mat, point, Math.round(12 + 12 * e + pieces * 2), { speed: 8 + 4 * e, size: kind === 'glint' ? 0.12 : 0.14, up: 5, dir });
            this.dust(mat, point, Math.round(2 + 3 * e), { size: 0.5, linger: kind === 'chip', spread: 1.6 });
        }
    }
    trail(pos) {
        this.parts.puff(pos.x, pos.y, pos.z, (R() - 0.5) * 0.6, 0.4, (R() - 0.5) * 0.6, 0.12 + R() * 0.08, 0.7, 0.75, 0.75, 0.75, { rise: 0.4, drag: 1.5, grow: 1.2 });
        if(R() < 0.6) this.fire.add([pos.x, pos.y, pos.z], [0, 0, 0], 0.12, 0.12, _c.setRGB(1, 0.6, 0.2));
    }
    explosion(center, radius, kind) {
        const n = Math.round(4 + radius * 2);
        for(let i = 0; i < n; i++) {
            const v = [(R() - 0.5) * radius * 3, R() * radius * 2.5, (R() - 0.5) * radius * 3];
            this.fire.add([center[0] + v[0] * 0.1, center[1] + v[1] * 0.1, center[2] + v[2] * 0.1], v, radius * (0.35 + R() * 0.3), 0.3 + R() * 0.25, _c.setRGB(1, 0.55 + R() * 0.3, 0.15));
        }
        const P = this.parts;
        for(let i = 0; i < n + 2; i++) {
            const g = 0.25 + R() * 0.2;
            P.puff(center[0] + (R() - 0.5) * radius, center[1] + R() * radius * 0.6, center[2] + (R() - 0.5) * radius,
                (R() - 0.5) * radius * 1.5, 1 + R() * radius, (R() - 0.5) * radius * 1.5, radius * (0.3 + R() * 0.3), 1.6 + R() * 1.5, g, g, g * 0.95);
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
        // material fracture events (src/physics/VoxelBodies.js), on ctx.events or through the game
        const on = (name, fn) => { ev.addEventListener(name, (e) => { if(e.detail?.point) fn(e.detail); }); g.on(name, (d) => { if(d?.point) fn(d); }); };
        on('fracture', (d) => this.fracture(d.point, d.mat ?? 0, { mode: d.mode, energy: d.energy ?? 1, pieces: d.pieces ?? 2, dir: d.dir }));
        on('splinters', (d) => { this.emit(d.mat ?? 10, d.point, Math.min(40, d.count ?? 12), { speed: 7, size: 0.1, up: 4, dir: d.dir, axis: d.axis }); this.dust(d.mat ?? 10, d.point, 1, { size: 0.3 }); });
        on('crumble', (d) => {
            const v = Math.max(0.1, d.volume ?? 1);
            this.emit(d.mat ?? 1, d.point, Math.round(Math.min(40, 6 + v * 6)), { speed: 3, size: 0.14, up: 2 });
            this.dust(d.mat ?? 1, d.point, Math.round(Math.min(10, 2 + v * 2)), { size: 0.5, spread: 1 + Math.cbrt(v) });
        });
        on('bend', (d) => { const a = Math.min(1, d.amount ?? 0.3); if(R() < 0.3 + a) this.emit(d.mat ?? 6, d.point, Math.round(2 + a * 10), { speed: 5, size: 0.06, up: 2 }); });
        on('chips', (d) => this.emit(d.mat ?? 0, d.point, Math.min(40, d.count ?? 8), { speed: 7, size: 0.1, up: 4 }));
        g.on('explosion', ({ center, radius, kind }) => this.explosion(center, kind === 'rock' ? radius * 0.6 : radius, kind));
        g.on('shatter', ({ point, mat, volume }) => this.fracture(point, mat ?? 0, { energy: 1 + Math.min(2, volume ?? 1), pieces: 4 }));
        g.on('slam', ({ point, mat }) => this.burst(point, { count: 12, speed: 6, size: 0.12, mats: [mat], up: 4, dust: 5 }));
        g.on('rip', ({ point, mat }) => { if(point) this.burst(point, { count: 14, speed: 5, size: 0.1, mats: [mat], up: 5, dust: 4 }); });
        g.on('punch', ({ point, kind }) => { if(kind === 'prop' || kind === 'actor') this.burst(point, { count: 5, speed: 5, size: 0.06, mats: [kind === 'actor' ? 7 : 10], dust: 1 }); });
        g.on('build', ({ center, size }) => this.burst([center[0], center[1] - size[1] / 2, center[2]], { count: 6, speed: 3, size: 0.08, mats: [8], dust: 6 }));
        g.on('damage', ({ actor }) => { if(!actor.isPlayer) { const c = actor.body.center; this.burst([c.x, c.y + 0.3, c.z], { count: 6, speed: 6, size: 0.07, mats: [7], dust: 0 }); } });
        g.on('deposit', ({ crate }) => { const t = crate.prop.body.translation(); for(let i = 0; i < 24; i++) this.fire.add([t.x, t.y + 0.5, t.z], [(R() - 0.5) * 6, 4 + R() * 6, (R() - 0.5) * 6], 0.08, 0.9, _c.setRGB(1, 0.85, 0.3)); });
    }

    update(dt) {
        this.parts.update(dt);
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
