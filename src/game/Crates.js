/**
 * Supply crates: physics boxes scattered over the level and buried in sealed caches (WorldParty's gen-fortwar game
 * config). Walk into one to pick it up (it rides over your head), walk into your vault to bank it. A vault's crates
 * can be stolen by the other team. A carrier who dies drops the crate. Score = crates in your vault.
 */
import * as THREE from 'three/webgpu';
import { GAME, NUDGE } from '../level/fortwar.js';

const nudge = p => p.map(v => v + NUDGE);
// gen-fortwar's scatter: bridge stump, gorge bed (two), arch top, the tube, then per side a crag, the sewer jog,
// the cave entrance and the front tower top
const SCATTER = [[0, 1.1, 6.5], [3, -5.5, 9.5], [-3, -5.5, -9.5], [0, 7.5, 32], [0, 0.5, -27.5]];
for(const s of [-1, 1]) SCATTER.push([s * 38, 8.0, 19.5], [s * 30, -5.5, 5], [s * 43, 0.5, -22], [s * 36.5, 10.0, 12.5]);
const CACHES = [[-46, -9.5, 6.5], [46, -9.5, 6.5], [-14, -10.5, -11.5], [14, -10.5, -11.5], [-0.8, -14.5, 0.8], [0.8, -14.5, -0.8]];
const SLOTS = [[57.5, -2], [55, -2], [52.5, -2], [57.5, 2], [55, 2], [52.5, 2], [57.5, 0], [55, 0], [52.5, 0], [51, -3.5], [51, 3.5], [58.5, 3.5]];
export const HALF = 0.45;
const _pos = { x: 0, y: 0, z: 0 }, _rot = { x: 0, y: 0, z: 0, w: 1 };
export const PICKUP_RADIUS = 1.7;

export function inBox(b, p) {
    return p.x >= b.min[0] && p.x <= b.max[0] && p.y >= b.min[1] - 0.5 && p.y <= b.max[1] && p.z >= b.min[2] && p.z <= b.max[2];
}

export class Crates {
    constructor(game) {
        this.game = game;
        this.ctx = game.ctx;
        this.list = [];
        this.vaults = { red: GAME.teams.red.vault, blue: GAME.teams.blue.vault };
        this.slots = { red: SLOTS.map(([x, z]) => nudge([-x, -5.5, z])), blue: SLOTS.map(([x, z]) => nudge([x, -5.5, z])) };
        const wood = new THREE.MeshStandardNodeMaterial({ color: 0xc8913f, roughness: 0.8 });
        const strap = new THREE.MeshStandardNodeMaterial({ color: 0x4a3018, roughness: 0.6, metalness: 0.2 });
        const gold = new THREE.MeshStandardNodeMaterial({ color: 0xffd040, emissive: 0xffa000, emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.6 });
        this.mats = { wood, strap, gold };
        this.beamMat = new THREE.MeshBasicNodeMaterial({ color: 0xffe080, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending });
        this.beamGeo = new THREE.CylinderGeometry(0.12, 0.3, 30, 8, 1, true); this.beamGeo.translate(0, 15, 0);
        for(const p of SCATTER) this.spawn(nudge(p), false);
        for(const p of CACHES) this.spawn(nudge(p), true);
    }
    makeMesh() {
        const g = new THREE.Group();
        const s = HALF * 2;
        const body = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), this.mats.wood); g.add(body);
        for(const z of [-0.28, 0.28]) { const b = new THREE.Mesh(new THREE.BoxGeometry(s + 0.03, s + 0.03, 0.1), this.mats.strap); b.position.z = z; g.add(b); }
        const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.16), this.mats.gold); gem.position.y = HALF + 0.02; gem.scale.y = 0.6; g.add(gem);
        g.traverse(o => { if(o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        return g;
    }
    spawn(pos, buried) {
        const mesh = this.makeMesh();
        const prop = this.ctx.physics.addBody({ shape: 'box', size: [HALF, HALF, HALF], position: pos, mesh, density: 400, friction: 0.8, restitution: 0.05, userData: { crate: true, mat: 10 } });
        const beam = new THREE.Mesh(this.beamGeo, this.beamMat); beam.renderOrder = 5;
        this.ctx.scene.add(beam);
        const c = { prop, mesh, home: pos, buried, carrier: null, vault: null, idle: 0, beam, id: this.list.length };
        this.list.push(c);
        return c;
    }
    pos(c) { const t = c.prop.body.translation(); return t; }
    /** Which team's vault holds it (null if none). */
    vaultOf(t) { for(const team of ['red', 'blue']) if(inBox(this.vaults[team], t)) return team; return null; }
    count(team) { let n = 0; for(const c of this.list) if(!c.carrier && c.vault === team) n++; return n; }

    pickUp(c, actor) {
        const { R } = this.ctx.physics;
        c.carrier = actor; actor.carrying = c;
        c.prop.body.setBodyType(R.RigidBodyType.KinematicPositionBased, true);
        c.prop.collider.setEnabled(false);
        c.vaultBefore = c.vault; c.vault = null;
        this.game.emit('pickup', { crate: c, actor, from: c.vaultBefore });
    }
    drop(c, deposit = false) {
        const a = c.carrier; if(!a) return;
        const { R } = this.ctx.physics;
        c.carrier = null; a.carrying = null;
        const b = c.prop.body;
        let at;
        if(deposit) {
            // the first free slot of the vault
            const used = this.list.filter(o => o !== c && !o.carrier && o.vault === a.team).map(o => this.pos(o));
            at = this.slots[a.team].find(s => used.every(u => Math.hypot(u.x - s[0], u.z - s[2]) > 1.0)) || this.slots[a.team][0];
            at = [at[0], at[1] + 0.3, at[2]];
        } else { const t = a.body.center; at = [t.x, t.y + 0.2, t.z]; }
        b.setBodyType(R.RigidBodyType.Dynamic, true);
        b.setTranslation({ x: at[0], y: at[1], z: at[2] }, true);
        b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
        const v = deposit ? { x: 0, y: 0, z: 0 } : a.body.vel;
        b.setLinvel({ x: v.x * 0.6, y: Math.max(0, v.y * 0.6) + 2, z: v.z * 0.6 }, true);
        c.prop.collider.setEnabled(true);
        a.ignoreTemp(c.prop.collider.handle, 1.0);
        c.idle = 0;
        if(deposit) { c.vault = a.team; this.game.emit('deposit', { crate: c, actor: a }); }
    }
    returnHome(c) {
        const b = c.prop.body;
        if(c.carrier) this.drop(c);
        b.setTranslation({ x: c.home[0], y: c.home[1] + 0.5, z: c.home[2] }, true);
        b.setLinvel({ x: 0, y: 0, z: 0 }, true);
        b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }

    update(dt) {
        const t0 = performance.now() / 1000;
        for(const c of this.list) {
            const b = c.prop.body;
            if(c.carrier) {
                const a = c.carrier;
                if(!a.alive) { this.drop(c); continue; }
                const p = a.viewCenter, yaw = a.yaw ?? 0;
                _pos.x = p.x; _pos.y = p.y + a.body.halfHeight + a.body.radius + HALF + 0.15 + Math.sin(t0 * 6) * 0.04; _pos.z = p.z;
                b.setNextKinematicTranslation(_pos);
                _rot.y = Math.sin(yaw / 2); _rot.w = Math.cos(yaw / 2);
                b.setNextKinematicRotation(_rot);
                // banked in our vault?
                if(inBox(this.vaults[a.team], p)) this.drop(c, true);
                c.beam.visible = false;
                continue;
            }
            const t = b.translation();
            if(t.y < -30) { this.returnHome(c); continue; }
            c.vault = this.vaultOf(t);
            // the beacon: free crates show a light beam (not the buried ones: those are for diggers)
            c.beam.visible = !c.vault && !c.buried;
            c.beam.position.set(t.x, t.y + HALF, t.z);
            if(c.buried && Math.hypot(t.x - c.home[0], t.y - c.home[1], t.z - c.home[2]) > 1.5) c.buried = false; // dug out and moved
            // pickups: a living actor walking into it, unless it already sits in their own vault
            for(const a of this.game.actors) {
                if(!a.alive || a.carrying || a.held) continue;
                if(c.vault === a.team) continue;
                if(a.dropCooldown > 0) continue;
                const p = a.body.center;
                if(Math.abs(p.x - t.x) < PICKUP_RADIUS && Math.abs(p.z - t.z) < PICKUP_RADIUS && Math.abs(p.y - t.y) < 1.9 && Math.hypot(p.x - t.x, p.z - t.z) < PICKUP_RADIUS) { this.pickUp(c, a); break; }
            }
        }
    }
}
