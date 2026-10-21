/**
 * First-person view model: big Donkey-Kong fists plus the selected tool, parented to the camera. Animations: punch
 * jab, recoil kick, drill spin, grenade wind-up, idle sway and walk bob. Cheap primitives only.
 */
import * as THREE from 'three/webgpu';

const mat = (color, o = {}) => new THREE.MeshStandardNodeMaterial({ color, roughness: 0.7, ...o });

export class ViewModel {
    constructor(game, player) {
        this.game = game;
        this.player = player;
        const cam = game.ctx.camera;
        if(!cam.parent) game.ctx.scene.add(cam);
        this.root = new THREE.Group();
        cam.add(this.root);
        const fur = mat(0x6b3f1f), skin = mat(0xc89a6a);
        const fist = () => {
            const g = new THREE.Group();
            const f = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 9), skin); f.scale.set(1, 0.85, 1.05); g.add(f);
            const k = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.13, 3, 8), skin); k.rotation.z = Math.PI / 2; k.position.set(0, 0.035, -0.09); g.add(k);
            const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.1, 0.5, 8), fur); arm.rotation.x = Math.PI / 2; arm.position.z = 0.32; g.add(arm);
            return g;
        };
        this.right = fist(); this.right.position.set(0.32, -0.34, -0.58);
        this.left = fist(); this.left.position.set(-0.32, -0.36, -0.58);
        this.root.add(this.right, this.left);
        // tools held in the right hand
        this.tools = {};
        const launcher = new THREE.Group();
        const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.75, 12), mat(0x3d5a3a, { metalness: 0.3 })); tube.rotation.x = Math.PI / 2; launcher.add(tube);
        const mouth = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.08, 12), mat(0x222222)); mouth.rotation.x = Math.PI / 2; mouth.position.z = -0.38; launcher.add(mouth);
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.14, 8), mat(0xd04020, { emissive: 0x501000 })); tip.rotation.x = -Math.PI / 2; tip.position.z = -0.45; launcher.add(tip);
        launcher.position.set(0.3, -0.27, -0.55);
        this.tools.rocket = launcher;
        const nade = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), mat(0x2f3a2a, { metalness: 0.3 })); nade.position.set(0.3, -0.18, -0.62);
        this.tools.grenade = nade;
        const drill = new THREE.Group();
        const bit = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.4, 7), mat(0xb0b8c0, { metalness: 0.8, roughness: 0.3, flatShading: true })); bit.rotation.x = -Math.PI / 2; bit.position.z = -0.32; drill.add(bit);
        const motor = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.24), mat(0xe0a020)); drill.add(motor);
        drill.position.set(0.26, -0.22, -0.55);
        this.drillBit = bit;
        this.tools.drill = drill;
        const brick = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.12), mat(0xc98b7e)); brick.position.set(0.3, -0.17, -0.6);
        this.tools.mason = brick;
        const bust = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 10), mat(0xe0b020, { metalness: 0.4 })); bust.position.set(0.3, -0.16, -0.62);
        this.tools.buster = bust;
        for(const k in this.tools) { this.tools[k].visible = false; this.root.add(this.tools[k]); }
        // smaller parts at the same places: they read as held, not as walls
        for(const part of [this.right, this.left, ...Object.values(this.tools)]) part.scale.setScalar(0.5);
        this.root.traverse(o => { if(o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; o.renderOrder = 10; } });
        this.jab = 0; this.jabSide = 1; this.kickZ = 0; this.t = 0; this.spin = 0;
        this.swap = 0;
        game.on('fired', (d) => {
            if(d.tool === 'punch' || d.tool === 'grab' || d.tool === 'throw') { this.jab = 1; this.jabSide = d.tool === 'throw' ? 1 : -this.jabSide; }
            else this.kickZ = d.tool === 'rocket' ? 0.14 : d.tool === 'drill' ? 0.04 : 0.08;
        });
        game.on('tool', () => { this.swap = 1; });
    }
    update(dt) {
        const p = this.player, a = p.arsenal;
        this.root.visible = p.alive;
        if(!p.alive) return;
        this.t += dt;
        const tool = a.tool;
        for(const k in this.tools) this.tools[k].visible = k === tool && !(tool === 'buster' && p.busters <= 0);
        this.jab = Math.max(0, this.jab - dt * 6);
        this.kickZ *= Math.max(0, 1 - dt * 14);
        this.swap = Math.max(0, this.swap - dt * 5);
        const bob = p.bob, sway = Math.sin(this.t * 1.6) * 0.006;
        this.root.position.set(Math.sin(bob * 0.5) * 0.02, -Math.abs(Math.sin(bob)) * 0.02 + sway - this.swap * 0.25, this.kickZ);
        this.root.rotation.x = this.kickZ * 0.8;
        // fists: the jab goes out and back; with something held both fists go up
        const j = Math.sin(Math.min(1, 1 - this.jab) * Math.PI) * (this.jab > 0 ? 1 : 0);
        const holding = !!p.held;
        const toolOut = tool !== 'punch' && tool !== 'grab';
        const r = this.right, l = this.left;
        r.visible = !toolOut || holding;
        r.position.set(0.32, holding ? 0.22 : -0.34, -0.58 - (this.jabSide > 0 ? j * 0.45 : 0));
        l.position.set(-0.32, holding ? 0.22 : -0.36, -0.58 - (this.jabSide < 0 ? j * 0.45 : 0));
        r.rotation.x = l.rotation.x = holding ? 1.4 : 0;
        if(tool === 'drill') { const on = p.input.down('fire'); this.spin += dt * (on ? 40 : 2); this.drillBit.rotation.y = this.spin; this.tools.drill.position.x = 0.26 + (on ? (Math.random() - 0.5) * 0.01 : 0); }
        if(tool === 'grenade') this.tools.grenade.position.z = -0.62 + a.charge * 0.18;
    }
}
