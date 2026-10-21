/**
 * The player's tools: selection (number keys, wheel, toolbar), cooldowns (exposed for the HUD), and what each does
 * with the fire button. Punch (F / middle mouse) and grab (E / right mouse) work whatever tool is selected.
 *
 *   punch   click: bite a rock out of the terrain ahead, knock bodies and enemies
 *   grab    hold: rip a lump of terrain (or a loose body) out and carry it overhead; release: throw (it shatters)
 *   rocket  hold: fire rockets (rocket jump by aiming at your feet)
 *   grenade hold to charge, release to throw
 *   drill   hold: dig a walkable tunnel the way you look
 *   mason   click: build the selected shape (press 6 again or the tool's button to switch shape); costs stone
 *   buster  click: one bunker buster per life
 */
import * as THREE from 'three/webgpu';
import { WEAPONS, TOOLS, MASON_SHAPES } from './defs.js';
import { GAME } from '../../level/fortwar.js';

const MASON_GRID = 0.5, MASON_ORIGIN = 0.1;
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _tgt = { x: 0, y: 0, z: 0 };
const snap = (v) => MASON_ORIGIN + Math.round((v - MASON_ORIGIN) / MASON_GRID) * MASON_GRID;

export class Arsenal {
    constructor(game, player) {
        this.game = game;
        this.player = player;
        this.combat = game.combat;
        this.index = 2; // start on the rocket launcher
        this.cool = Object.fromEntries(Object.keys(WEAPONS).map(k => [k, 0]));
        this.charge = 0;           // grenade charge 0..1 while held
        this.charging = false;
        this.masonShape = 0;
        this.masonPreview = null;  // { min, max, ok } for the HUD / ghost
        this.grabFrom = null;      // 'fire' or 'grab': which button holds the rock
        this.holdT = 0;
        player.input.onTool((t) => this.select(t));
        // ghost box for the mason
        this.ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicNodeMaterial({ color: 0xffd080, transparent: true, opacity: 0.28, depthWrite: false }));
        this.ghost.visible = false;
        this.ghostEdges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicNodeMaterial({ color: 0xffe0a0 }));
        this.ghost.add(this.ghostEdges);
        game.ctx.scene.add(this.ghost);
    }
    get tool() { return TOOLS[this.index]; }
    select(t) {
        let i = t === 'next' ? (this.index + 1) % TOOLS.length : t === 'prev' ? (this.index + TOOLS.length - 1) % TOOLS.length : t;
        if(typeof i !== 'number' || i < 0 || i >= TOOLS.length) return;
        if(i === this.index && TOOLS[i] === 'mason') { this.masonShape = (this.masonShape + 1) % MASON_SHAPES.length; this.game.emit('ui', { sound: 'click' }); return; }
        if(i === this.index) return;
        if(this.charging) { this.charging = false; this.charge = 0; }
        if(this.held && this.grabFrom === 'fire') this.release(false);
        this.index = i;
        this.game.emit('tool', { tool: this.tool });
    }
    get held() { return this.player.held; }
    ready(k) { return this.cool[k] <= 0; }
    use(k) { this.cool[k] = WEAPONS[k].cooldown; }
    /** Cooldown fraction 0..1 remaining, for the HUD. */
    coolFrac(k) { return Math.max(0, this.cool[k] / WEAPONS[k].cooldown); }

    update(dt, input) {
        const p = this.player;
        for(const k in this.cool) this.cool[k] = Math.max(0, this.cool[k] - dt);
        if(this.game.over) return;
        const tool = this.tool;
        // universal buttons
        if(input.down('punch') && this.ready('punch') && !this.held) this.doPunch();
        if(input.pressed('grab')) this.grab('grab');
        if(input.released('grab') && this.grabFrom === 'grab') this.release(true);
        // the selected tool on the fire button
        const fireDown = input.down('fire'), firePressed = input.pressed('fire'), fireReleased = input.released('fire');
        switch(tool) {
            case 'punch': if(fireDown && this.ready('punch') && !this.held) this.doPunch(); break;
            case 'grab':
                if(firePressed) this.grab('fire');
                if(fireReleased && this.grabFrom === 'fire') this.release(true);
                break;
            case 'rocket':
                if(fireDown && this.ready('rocket')) {
                    this.use('rocket');
                    this.combat.fireRocket(p, this.muzzle(), p.aimDir());
                    p.kick(0.07); p.shake(0.18);
                    this.game.emit('fired', { tool });
                }
                break;
            case 'grenade':
                if(firePressed && this.ready('grenade')) { this.charging = true; this.charge = 0; }
                if(this.charging) this.charge = Math.min(1, this.charge + dt / WEAPONS.grenade.charge);
                if(fireReleased && this.charging) {
                    const g = WEAPONS.grenade;
                    this.charging = false;
                    this.use('grenade');
                    this.combat.throwFused(p, 'grenade', p.eye(), p.aimDir(), g.minSpeed + (g.maxSpeed - g.minSpeed) * this.charge);
                    this.charge = 0; p.kick(0.03);
                    this.game.emit('fired', { tool });
                }
                break;
            case 'drill':
                if(fireDown && this.ready('drill')) {
                    this.use('drill');
                    this.combat.dig(p, p.aimDir());
                    p.shake(0.12); p.kick(0.015);
                    this.game.emit('fired', { tool });
                }
                break;
            case 'mason':
                this.updateMasonPreview();
                if(firePressed && this.ready('mason')) this.doBuild();
                break;
            case 'buster':
                if(firePressed && this.ready('buster')) {
                    if(p.busters <= 0) { this.game.emit('hint', { text: 'One bunker buster per life' }); break; }
                    p.busters--;
                    this.use('buster');
                    this.combat.throwFused(p, 'buster', p.eye(), p.aimDir(), WEAPONS.buster.speed);
                    p.kick(0.06); p.shake(0.2);
                    this.game.emit('fired', { tool });
                }
                break;
        }
        this.ghost.visible = tool === 'mason' && !!this.masonPreview;
        if(this.held) this.updateHeld(dt);
    }

    muzzle() { const e = this.player.eye(), d = this.player.aimDir(); const s = Math.sin(this.player.yaw), c = Math.cos(this.player.yaw); return [e[0] + c * 0.18, e[1] - 0.12, e[2] - s * 0.18].map((v, i) => v + d[i] * 0.1); }

    doPunch() {
        const p = this.player;
        this.use('punch');
        const r = this.combat.punch(p, p.eye(), p.aimDir());
        p.shake(r === 'air' ? 0.04 : 0.22); p.kick(r === 'air' ? 0.01 : 0.04);
        this.game.emit('fired', { tool: 'punch', result: r });
    }

    grab(from) {
        const p = this.player;
        if(this.held || !this.ready('grab') || p.carrying) return;
        const prop = this.combat.rip(p, p.eye(), p.aimDir());
        this.use('grab');
        if(!prop) { this.game.emit('fired', { tool: 'grab', result: 'miss' }); return; }
        p.held = prop;
        this.grabFrom = from;
        this.holdT = 0;
        this.combat.hold(prop, true);
        p.shake(0.25);
        this.game.emit('fired', { tool: 'grab', result: 'rip' });
    }
    release(throwIt) {
        const p = this.player, prop = p.held;
        if(!prop) return;
        p.held = null; this.grabFrom = null;
        if(!this.game.ctx.physics.props.has(prop)) return;
        if(throwIt) {
            const d = p.aimDir();
            this.combat.throwHeld(p, prop, d, WEAPONS.grab.throwSpeed);
            p.kick(0.05); p.shake(0.15);
            this.game.emit('fired', { tool: 'throw' });
        } else this.combat.dropHeld(p, prop);
    }
    updateHeld(dt) {
        const p = this.player, prop = p.held;
        if(!this.game.ctx.physics.props.has(prop)) { p.held = null; this.grabFrom = null; return; }
        this.holdT += dt;
        const e = p.eye(), s = Math.sin(p.yaw), c = Math.cos(p.yaw);
        const target = _tgt; Object.assign(target, { x: e[0] - s * 1.05, y: e[1] + 1.3 + Math.sin(this.holdT * 5) * 0.04, z: e[2] - c * 1.05 });
        const b = prop.body, t = b.translation(), k = Math.min(1, dt * 18);
        target.x = t.x + (target.x - t.x) * k; target.y = t.y + (target.y - t.y) * k; target.z = t.z + (target.z - t.z) * k;
        b.setNextKinematicTranslation(target);
        _q.setFromEuler(_e.set(this.holdT * 0.7, p.yaw + this.holdT * 0.4, 0));
        b.setNextKinematicRotation(_q);
    }

    updateMasonPreview() {
        const p = this.player, e = p.eye(), d = p.aimDir();
        const hit = this.combat.raycast(e, d, WEAPONS.mason.maxDistance, p);
        if(!hit) { this.masonPreview = null; return; }
        const shape = MASON_SHAPES[this.masonShape];
        // the shape's x axis runs across the view: swap x/z when looking mostly along x
        const alongX = Math.abs(Math.sin(p.yaw)) > Math.abs(Math.cos(p.yaw));
        const sx = alongX ? shape.size[2] : shape.size[0], sz = alongX ? shape.size[0] : shape.size[2], sy = shape.size[1];
        const n = hit.normal, pt = hit.point;
        // stand it on what we hit (floors) or against it (walls)
        let cx = pt[0] + n[0] * sx / 2, cy = pt[1] + (n[1] > 0.5 ? sy / 2 : n[1] < -0.5 ? -sy / 2 : 0), cz = pt[2] + n[2] * sz / 2;
        if(n[1] > 0.5) { cx = pt[0]; cz = pt[2]; }
        const min = [snap(cx - sx / 2), snap(cy - sy / 2), snap(cz - sz / 2)];
        const max = [min[0] + sx, min[1] + sy, min[2] + sz];
        if(n[1] > 0.5) { min[1] = snap(pt[1]) - MASON_GRID; max[1] = min[1] + sy; } // sunk one cell into the floor, so it is part of it
        const vol = sx * sy * sz;
        this.masonPreview = { min, max, volume: vol, ok: vol <= p.stone + 1e-6 };
        this.ghost.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
        this.ghost.scale.set(sx, sy, sz);
        this.ghost.material.color.set(this.masonPreview.ok ? 0xffd080 : 0xff4030);
    }
    doBuild() {
        const p = this.player, pv = this.masonPreview;
        if(!pv) return;
        if(!pv.ok) { this.game.emit('hint', { text: `Not enough stone (${pv.volume.toFixed(0)} needed): dig or punch for more` }); return; }
        this.use('mason');
        const added = this.combat.build(p, pv.min, pv.max, GAME.teams[p.team].material);
        if(!added) { this.game.emit('hint', { text: 'Someone is in the way' }); return; }
        p.stone = Math.max(0, p.stone - pv.volume);
        p.shake(0.12);
        this.game.emit('fired', { tool: 'mason' });
    }
}
