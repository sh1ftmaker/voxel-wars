/** Developer fly camera: WASD/QE (Shift fast), mouse look under pointer lock. Left click blasts, right click builds,
 *  B drops a box. Stands in for the player until the game's PlayerController takes over. */
import * as THREE from 'three/webgpu';
import { sphere } from '../voxel/brushes.js';

export class FlyCamera {
    constructor(ctx) {
        this.ctx = ctx;
        const { camera, renderer, world, physics } = ctx;
        this.keys = new Set();
        addEventListener('keydown', e => this.keys.add(e.code));
        addEventListener('keyup', e => this.keys.delete(e.code));
        this.euler = new THREE.Euler(0, -Math.PI / 2, 0, 'YXZ');
        camera.quaternion.setFromEuler(this.euler);
        renderer.domElement.addEventListener('click', () => renderer.domElement.requestPointerLock());
        addEventListener('mousemove', e => {
            if(document.pointerLockElement !== renderer.domElement) return;
            this.euler.y -= e.movementX * 0.0022; this.euler.x = Math.max(-1.55, Math.min(1.55, this.euler.x - e.movementY * 0.0022));
            camera.quaternion.setFromEuler(this.euler);
        });
        let seed = 1;
        addEventListener('mousedown', e => {
            if(document.pointerLockElement !== renderer.domElement) return;
            const d = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).toArray();
            const hit = world.raycast(camera.position.toArray(), d, 150);
            if(!hit) return;
            if(e.button === 0) ctx.destruction.blast(hit.point, 3);
            else if(e.button === 2) ctx.destruction.carve(sphere(hit.point, 1.5), { op: 'add', mat: 0 });
        });
        addEventListener('keydown', e => {
            if(e.code !== 'KeyB') return;
            const p = camera.position.clone().add(new THREE.Vector3(0, 0, -3).applyQuaternion(camera.quaternion));
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardNodeMaterial({ color: 0xb08040 }));
            mesh.castShadow = mesh.receiveShadow = true;
            physics.addBody({ shape: 'box', size: [0.5, 0.5, 0.5], position: p.toArray(), mesh });
        });
        addEventListener('contextmenu', e => e.preventDefault());
    }
    update(dt) {
        const k = this.keys, cam = this.ctx.camera;
        const v = new THREE.Vector3((k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0), (k.has('KeyE') || k.has('Space') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0), (k.has('KeyS') ? 1 : 0) - (k.has('KeyW') ? 1 : 0));
        cam.position.addScaledVector(v.applyQuaternion(cam.quaternion), dt * (k.has('ShiftLeft') ? 40 : 14));
    }
}
