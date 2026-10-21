/**
 * Material debris particles: one pooled, instanced system per look, four draw calls in all.
 *
 *   solid  opaque low-poly shards, flat shaded, scaled per kind: stone chips (angular, tumble, bounce), wood splinters
 *          (long and thin, laid along the grain axis, spin, bounce once), dirt clods (roundish, stop at once)
 *   glass  thin transparent slivers that twinkle (brightness pulses per instance), fall and settle
 *   spark  additive streaks stretched along their velocity: metal sparks, short-lived, hot to red
 *   soft   transparent spheres with a per-instance opacity: dust, the lingering stone dust cloud, sand and snow puffs
 *
 * Simulation is on the CPU with structure-of-arrays pools and no allocation per frame. Terrain collision sphere
 * traces the world's SDF: a particle samples the SDF only once it has travelled the distance the last sample
 * guaranteed free (`safe`), so a particle in the air samples every few frames and one at rest never. Rotation is
 * a quaternion integrated without trig; instance matrices are written straight into the instance buffer and only
 * the live range is uploaded.
 *
 * Kinds (MATERIALS[id].particle, else the id map below): 'chip' | 'splinter' | 'clod' | 'glint' | 'spark' | 'puff' | 'dust'.
 */
import * as THREE from 'three/webgpu';
import { attribute, float, normalView, positionViewDirection } from 'three/tsl';
import { MATERIALS } from '../voxel/materials.js';

const GRAV = 30;
/** Fallback particle kind per material id (until materials.js names one): 10/14/15 wood (grain x/y/z), 16 glass. */
const KIND = { 0: 'chip', 1: 'clod', 2: 'clod', 3: 'puff', 4: 'puff', 5: 'chip', 6: 'spark', 7: 'clod', 8: 'chip', 9: 'chip', 10: 'splinter', 11: 'chip', 12: 'chip', 13: 'chip', 14: 'splinter', 15: 'splinter', 16: 'glint' };
const GRAIN = { 10: 0, 14: 1, 15: 2 };
const COLOR = { 14: 0x8b5a2b, 15: 0x8b5a2b, 16: 0xcfe6ef };
export const particleKind = (mat) => MATERIALS[mat]?.particle || KIND[mat] || 'chip';
export const grainAxis = (mat) => MATERIALS[mat]?.grain ?? GRAIN[mat] ?? -1;
export const materialColor = (mat) => (MATERIALS[mat] && !MATERIALS[mat].name?.startsWith('unused') ? MATERIALS[mat].color : COLOR[mat]) ?? MATERIALS[1].color;

const R = Math.random;

/** One instanced pool. Behaviour per particle: gravity scale, drag, bounce (restitution), bounces left. */
class Pool {
    constructor(scene, geo, mat, cap, { alpha = false, mode = 'solid' } = {}) {
        this.cap = cap; this.n = 0; this.mode = mode;
        this.mesh = new THREE.InstancedMesh(geo, mat, cap);
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
        this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        if(alpha) {
            this.alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
            this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
            geo.setAttribute('pAlpha', this.alphaAttr);
        }
        this.mesh.count = 0;
        this.mesh.frustumCulled = false;
        this.mesh.castShadow = false;
        scene.add(this.mesh);
        const f = (k) => new Float32Array(cap * k);
        this.pos = f(3); this.vel = f(3); this.q = f(4); this.w = f(3); this.scl = f(3); this.col = f(3);
        this.life = f(1); this.max = f(1); this.safe = f(1); this.grav = f(1); this.drag = f(1); this.bounce = f(1);
        this.rad = f(1); this.twk = f(1); this.alpha = f(1);
        this.left = new Int8Array(cap); this.rest = new Uint8Array(cap);
        this.arrs = [[this.pos, 3], [this.vel, 3], [this.q, 4], [this.w, 3], [this.scl, 3], [this.col, 3], [this.life, 1], [this.max, 1], [this.safe, 1],
            [this.grav, 1], [this.drag, 1], [this.bounce, 1], [this.rad, 1], [this.twk, 1], [this.alpha, 1], [this.left, 1], [this.rest, 1]];
        this.uploaded = 0;
    }
    /** A new particle (recycles the oldest-ish when full). Returns its index; the caller fills the rest. */
    add(x, y, z, vx, vy, vz, life) {
        let i = this.n;
        if(i >= this.cap) { i = (this.recycle = ((this.recycle || 0) + 1) % this.cap); }
        else this.n++;
        const o = i * 3;
        this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z;
        this.vel[o] = vx; this.vel[o + 1] = vy; this.vel[o + 2] = vz;
        this.life[i] = life; this.max[i] = life; this.safe[i] = 0; this.rest[i] = 0;
        this.grav[i] = 1; this.drag[i] = 0; this.bounce[i] = 0.3; this.left[i] = 3; this.twk[i] = R() * 6.283; this.alpha[i] = 1;
        // random orientation (uniform enough for debris) and no spin
        let a = R() - 0.5, b = R() - 0.5, c = R() - 0.5, d = R() - 0.5; const l = Math.hypot(a, b, c, d) || 1;
        const q = i * 4; this.q[q] = a / l; this.q[q + 1] = b / l; this.q[q + 2] = c / l; this.q[q + 3] = d / l;
        this.w[o] = this.w[o + 1] = this.w[o + 2] = 0;
        return i;
    }
    kill(i) {
        const j = --this.n;
        if(i === j) return;
        for(const [a, k] of this.arrs) for(let c = 0; c < k; c++) a[i * k + c] = a[j * k + c];
    }
    /** Orientation with its long axis (local z) along `axis` (0 x, 1 y, 2 z), turned by a random angle about it. */
    alongAxis(i, axis) {
        const t = R() * Math.PI, s = Math.sin(t), c = Math.cos(t), q = i * 4;
        // z->x: rotate 90° about y; z->y: -90° about x; z->z: identity; then the roll about the axis
        const h = Math.SQRT1_2;
        let bx = 0, by = 0, bz = 0, bw = 1;
        if(axis === 0) { by = h; bw = h; } else if(axis === 1) { bx = -h; bw = h; }
        // roll about local z first: r = (0, 0, s, c) (half angle t), q = b * r
        this.q[q] = bw * 0 + bx * c + by * s - bz * 0;
        this.q[q + 1] = bw * 0 - bx * s + by * c + bz * 0;
        this.q[q + 2] = bw * s + bx * 0 - by * 0 + bz * c;
        this.q[q + 3] = bw * c - bx * 0 - by * 0 - bz * s;
    }
}

const _n = [0, 0, 0];

export class Particles {
    constructor(scene, world) {
        this.world = world;
        const shard = new THREE.IcosahedronGeometry(1, 0);
        this.solid = new Pool(scene, shard, new THREE.MeshStandardNodeMaterial({ roughness: 0.85, flatShading: true }), 1600);
        const glassMat = new THREE.MeshBasicNodeMaterial({ transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide });
        this.glass = new Pool(scene, new THREE.OctahedronGeometry(1, 0), glassMat, 500);
        const sparkMat = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
        this.spark = new Pool(scene, new THREE.BoxGeometry(1, 1, 1), sparkMat, 600, { mode: 'spark' });
        const softGeo = new THREE.IcosahedronGeometry(1, 2);
        const softMat = new THREE.MeshStandardNodeMaterial({ roughness: 1, transparent: true, depthWrite: false });
        this.soft = new Pool(scene, softGeo, softMat, 700, { alpha: true, mode: 'soft' });
        // soft edges: fade where the sphere turns away from the eye, so puffs read as smoke rather than balls
        softMat.opacityNode = attribute('pAlpha', 'float').mul(normalView.dot(positionViewDirection).abs().pow(1.6)).mul(float(0.6));
        this.pools = [this.solid, this.glass, this.spark, this.soft];
        this.time = 0;
        this.samples = 0; // SDF samples last frame (for tests)
        this.ms = 0;
    }
    get live() { let n = 0; for(const p of this.pools) n += p.n; return n; }

    // ------------------------------------------------------------------ spawners (x, y, z: where; v: base velocity)

    /** Angular stone chips. */
    chip(x, y, z, vx, vy, vz, size, r, g, b) {
        const P = this.solid, i = P.add(x, y, z, vx, vy, vz, 2 + R() * 1.6), o = i * 3;
        P.scl[o] = size * (0.6 + R() * 0.7); P.scl[o + 1] = size * (0.5 + R() * 0.6); P.scl[o + 2] = size * (0.6 + R() * 0.8);
        P.rad[i] = size * 0.5; P.bounce[i] = 0.35; P.left[i] = 3; P.drag[i] = 0.05;
        this._spin(P, i, 14); this._col(P, i, r, g, b, 0.7, 0.45);
        return i;
    }
    /** Long thin splinters laid along the grain (`axis` 0 x, 1 y, 2 z; -1 any), spinning end over end. */
    splinter(x, y, z, vx, vy, vz, size, axis, r, g, b) {
        const P = this.solid, i = P.add(x, y, z, vx, vy, vz, 2.2 + R() * 1.5), o = i * 3;
        const len = size * (2.2 + R() * 2.6), th = size * (0.14 + R() * 0.12);
        P.scl[o] = th; P.scl[o + 1] = th * (0.6 + R() * 0.8); P.scl[o + 2] = len;
        if(axis >= 0) P.alongAxis(i, axis);
        P.rad[i] = th; P.bounce[i] = 0.3; P.left[i] = 1; P.drag[i] = 0.25; // bounce once, then lie
        this._spin(P, i, 18); this._col(P, i, r, g, b, 0.85, 0.35);
        return i;
    }
    /** Round dirt clods: drop and stop. */
    clod(x, y, z, vx, vy, vz, size, r, g, b) {
        const P = this.solid, i = P.add(x, y, z, vx, vy, vz, 1.8 + R() * 1.2), o = i * 3, s = size * (0.6 + R() * 0.6);
        P.scl[o] = s; P.scl[o + 1] = s * (0.75 + R() * 0.3); P.scl[o + 2] = s * (0.85 + R() * 0.3);
        P.rad[i] = s * 0.6; P.bounce[i] = 0.12; P.left[i] = 1; P.drag[i] = 0.1;
        this._spin(P, i, 6); this._col(P, i, r, g, b, 0.75, 0.4);
        return i;
    }
    /** Thin glass slivers that twinkle. */
    glint(x, y, z, vx, vy, vz, size) {
        const P = this.glass, i = P.add(x, y, z, vx, vy, vz, 2.4 + R() * 1.6), o = i * 3;
        P.scl[o] = size * (0.6 + R() * 0.8); P.scl[o + 1] = size * 0.06; P.scl[o + 2] = size * (0.9 + R() * 1.4);
        P.rad[i] = size * 0.2; P.bounce[i] = 0.25; P.left[i] = 2; P.drag[i] = 0.15;
        this._spin(P, i, 16);
        const k = 0.8 + R() * 0.2; P.col[o] = 0.75 * k; P.col[o + 1] = 0.9 * k; P.col[o + 2] = 1.0 * k;
        return i;
    }
    /** Hot metal sparks (streaks along their velocity). */
    sparkle(x, y, z, vx, vy, vz, size = 0.045) {
        const P = this.spark, i = P.add(x, y, z, vx, vy, vz, 0.45 + R() * 0.6), o = i * 3;
        P.scl[o] = size; P.scl[o + 1] = size; P.scl[o + 2] = size;
        P.rad[i] = 0.02; P.bounce[i] = 0.45; P.left[i] = 2; P.drag[i] = 0.6; P.grav[i] = 0.8;
        // over-bright (additive, tone mapped): reads as hot metal in daylight
        P.col[o] = 4; P.col[o + 1] = 2 + R() * 1.2; P.col[o + 2] = 0.5 + R() * 0.5;
        return i;
    }
    /** Soft dust and puffs: `rise` lift (m/s²), `grow` how much bigger it gets over its life. */
    puff(x, y, z, vx, vy, vz, size, life, r, g, b, { rise = 0.4, drag = 1.5, grow = 1.2, alpha = 1 } = {}) {
        const P = this.soft, i = P.add(x, y, z, vx, vy, vz, life), o = i * 3;
        P.scl[o] = P.scl[o + 1] = P.scl[o + 2] = size;
        P.grav[i] = -rise / GRAV; P.drag[i] = drag; P.bounce[i] = grow; P.alpha[i] = alpha; P.left[i] = -1;
        P.col[o] = r; P.col[o + 1] = g; P.col[o + 2] = b;
        return i;
    }
    _spin(P, i, s) { const o = i * 3; P.w[o] = (R() - 0.5) * s; P.w[o + 1] = (R() - 0.5) * s; P.w[o + 2] = (R() - 0.5) * s; }
    _col(P, i, r, g, b, lo, span) { const k = lo + R() * span, o = i * 3; P.col[o] = r * k; P.col[o + 1] = g * k; P.col[o + 2] = b * k; }

    // ------------------------------------------------------------------ frame

    update(dt) {
        const t0 = performance.now();
        this.time += dt;
        this.samples = 0;
        this._ballistic(this.solid, dt);
        this._ballistic(this.glass, dt);
        this._ballistic(this.spark, dt);
        this._soft(this.soft, dt);
        for(const p of this.pools) this._flush(p);
        this.ms = performance.now() - t0;
    }

    /** Gravity, drag, quaternion spin, SDF sphere-traced terrain bounces; at rest: no work until it fades. */
    _ballistic(P, dt) {
        const w = this.world, pos = P.pos, vel = P.vel, q = P.q, sp = P.w;
        for(let i = P.n - 1; i >= 0; i--) {
            if((P.life[i] -= dt) <= 0) { P.kill(i); continue; }
            if(P.rest[i]) continue;
            const o = i * 3;
            const k = 1 - Math.min(1, P.drag[i] * dt);
            let vx = vel[o] * k, vy = vel[o + 1] * k - GRAV * P.grav[i] * dt, vz = vel[o + 2] * k;
            const step = Math.sqrt(vx * vx + vy * vy + vz * vz) * dt;
            let x = pos[o] + vx * dt, y = pos[o + 1] + vy * dt, z = pos[o + 2] + vz * dt;
            P.safe[i] -= step;
            if(P.safe[i] <= 0) {
                const d = w.sample(x, y, z); this.samples++;
                const r = P.rad[i];
                if(d < r) {
                    // hit: reflect off the surface normal, lose speed; out of bounces or slow: rest here
                    w.normal(x, y, z, _n); this.samples += 6;
                    const vn = vx * _n[0] + vy * _n[1] + vz * _n[2];
                    x = pos[o]; y = pos[o + 1]; z = pos[o + 2];
                    if(vn < 0) {
                        const e = P.bounce[i], f = 0.55;
                        vx = (vx - vn * _n[0]) * f - vn * _n[0] * e;
                        vy = (vy - vn * _n[1]) * f - vn * _n[1] * e;
                        vz = (vz - vn * _n[2]) * f - vn * _n[2] * e;
                    }
                    sp[o] *= 0.5; sp[o + 1] *= 0.5; sp[o + 2] *= 0.5;
                    const s2 = vx * vx + vy * vy + vz * vz;
                    if(--P.left[i] < 0 || s2 < 2) {
                        P.rest[i] = 1; vx = vy = vz = 0;
                        if(P.mode === 'spark') P.life[i] = Math.min(P.life[i], 0.08);
                        else P.life[i] = Math.min(P.life[i], 0.8 + R() * 1.4);
                    }
                    P.safe[i] = 0;
                } else P.safe[i] = d - r;
            }
            pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
            vel[o] = vx; vel[o + 1] = vy; vel[o + 2] = vz;
            // q += 0.5 * (w, 0) * q * dt, renormalized
            const wx = sp[o] * dt * 0.5, wy = sp[o + 1] * dt * 0.5, wz = sp[o + 2] * dt * 0.5, j = i * 4;
            const qx = q[j], qy = q[j + 1], qz = q[j + 2], qw = q[j + 3];
            const nx = qx + wx * qw + wy * qz - wz * qy, ny = qy + wy * qw + wz * qx - wx * qz, nz = qz + wz * qw + wx * qy - wy * qx, nw = qw - wx * qx - wy * qy - wz * qz;
            const l = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
            q[j] = nx * l; q[j + 1] = ny * l; q[j + 2] = nz * l; q[j + 3] = nw * l;
        }
    }

    /** Dust and puffs: drag, lift, no collision. */
    _soft(P, dt) {
        const pos = P.pos, vel = P.vel;
        for(let i = P.n - 1; i >= 0; i--) {
            if((P.life[i] -= dt) <= 0) { P.kill(i); continue; }
            const o = i * 3, k = 1 - Math.min(1, P.drag[i] * dt);
            vel[o] *= k; vel[o + 1] = vel[o + 1] * k - GRAV * P.grav[i] * dt; vel[o + 2] *= k;
            pos[o] += vel[o] * dt; pos[o + 1] += vel[o + 1] * dt; pos[o + 2] += vel[o + 2] * dt;
        }
    }

    /** Instance matrices (and colours, opacity) straight into the buffers; uploads only the live range. */
    _flush(P) {
        const m = P.mesh, n = P.n;
        if(n === 0 && P.uploaded === 0) return;
        const M = m.instanceMatrix.array, C = m.instanceColor.array, q = P.q, s = P.scl, pos = P.pos, col = P.col;
        const time = this.time;
        for(let i = 0; i < n; i++) {
            const o = i * 3, b = i * 16, life = P.life[i], max = P.max[i];
            let sx = s[o], sy = s[o + 1], sz = s[o + 2], cr = col[o], cg = col[o + 1], cb = col[o + 2];
            let x2, y2, z2, xy, xz, yz, wx, wy, wz;
            if(P.mode === 'spark') {
                // stretched along the velocity: the local z axis is the direction of travel
                const v = P.vel, vx = v[o], vy = v[o + 1], vz = v[o + 2], l = Math.sqrt(vx * vx + vy * vy + vz * vz);
                const t = life / max;
                sz = s[o + 2] + Math.min(0.6, l * 0.025);
                cr *= t * 1.4; cg *= t * t; cb *= t * t * t;
                // basis: z = v/|v|, x = normalize(z x up) (or x), y = z x x
                let zx = 0, zy = -1, zz = 0;
                if(l > 1e-4) { zx = vx / l; zy = vy / l; zz = vz / l; }
                let xx = zz, xy0 = 0, xz0 = -zx; let xl = Math.sqrt(xx * xx + xz0 * xz0);
                if(xl < 1e-4) { xx = 1; xz0 = 0; xl = 1; }
                xx /= xl; xz0 /= xl;
                const yx = zy * xz0 - zz * xy0, yy = zz * xx - zx * xz0, yz0 = zx * xy0 - zy * xx;
                M[b] = xx * sx; M[b + 1] = xy0 * sx; M[b + 2] = xz0 * sx; M[b + 3] = 0;
                M[b + 4] = yx * sy; M[b + 5] = yy * sy; M[b + 6] = yz0 * sy; M[b + 7] = 0;
                M[b + 8] = zx * sz; M[b + 9] = zy * sz; M[b + 10] = zz * sz; M[b + 11] = 0;
                M[b + 12] = pos[o]; M[b + 13] = pos[o + 1]; M[b + 14] = pos[o + 2]; M[b + 15] = 1;
                C[o] = cr; C[o + 1] = cg; C[o + 2] = cb;
                continue;
            }
            if(P.mode === 'soft') {
                const t = 1 - life / max, g = 1 + t * P.bounce[i];
                sx *= g; sy *= g; sz *= g;
                P.alphaAttr.array[i] = P.alpha[i] * Math.min(1, t * 8) * Math.min(1, life / (max * 0.5));
                M[b] = sx; M[b + 1] = 0; M[b + 2] = 0; M[b + 3] = 0; M[b + 4] = 0; M[b + 5] = sy; M[b + 6] = 0; M[b + 7] = 0;
                M[b + 8] = 0; M[b + 9] = 0; M[b + 10] = sz; M[b + 11] = 0;
                M[b + 12] = pos[o]; M[b + 13] = pos[o + 1]; M[b + 14] = pos[o + 2]; M[b + 15] = 1;
                C[o] = cr; C[o + 1] = cg; C[o + 2] = cb;
                continue;
            }
            // shrink away over the last half second
            const f = life < 0.5 ? life * 2 : 1;
            sx *= f; sy *= f; sz *= f;
            if(m.material.transparent) { // glass: twinkle (sharp brightness peaks)
                const tw = Math.sin(time * 9 + P.twk[i]); const k = tw > 0.8 ? 1 + (tw - 0.8) * 12 : 1;
                cr *= k; cg *= k; cb *= k;
            }
            const j = i * 4, qx = q[j], qy = q[j + 1], qz = q[j + 2], qw = q[j + 3];
            x2 = qx + qx; y2 = qy + qy; z2 = qz + qz;
            const xx = qx * x2; xy = qx * y2; xz = qx * z2; const yy = qy * y2; yz = qy * z2; const zz = qz * z2;
            wx = qw * x2; wy = qw * y2; wz = qw * z2;
            M[b] = (1 - (yy + zz)) * sx; M[b + 1] = (xy + wz) * sx; M[b + 2] = (xz - wy) * sx; M[b + 3] = 0;
            M[b + 4] = (xy - wz) * sy; M[b + 5] = (1 - (xx + zz)) * sy; M[b + 6] = (yz + wx) * sy; M[b + 7] = 0;
            M[b + 8] = (xz + wy) * sz; M[b + 9] = (yz - wx) * sz; M[b + 10] = (1 - (xx + yy)) * sz; M[b + 11] = 0;
            M[b + 12] = pos[o]; M[b + 13] = pos[o + 1]; M[b + 14] = pos[o + 2]; M[b + 15] = 1;
            C[o] = cr; C[o + 1] = cg; C[o + 2] = cb;
        }
        m.count = n;
        const up = Math.max(n, 1);
        const im = m.instanceMatrix, ic = m.instanceColor;
        im.clearUpdateRanges(); im.addUpdateRange(0, up * 16); im.needsUpdate = true;
        ic.clearUpdateRanges(); ic.addUpdateRange(0, up * 3); ic.needsUpdate = true;
        if(P.alphaAttr) { const a = P.alphaAttr; a.clearUpdateRanges(); a.addUpdateRange(0, up); a.needsUpdate = true; }
        P.uploaded = n;
    }
}
