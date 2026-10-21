/**
 * The third-person figure of a bot or another player: a team-coloured capsule body, a box head with a glowing visor,
 * a gun and two legs. makeAvatar(color) -> { group, gun, legs: [left, right] }; feet at the group's origin.
 * poseAvatar(av, { yaw, pitch, walk, speed }) swings the legs and points the gun.
 */
import * as THREE from 'three/webgpu';

export const TEAM_COLOR = { red: 0xd8463a, blue: 0x3a7be0 };
let dark = null, visorMat = null;

export function makeAvatar(color) {
    dark ??= new THREE.MeshStandardNodeMaterial({ color: 0x2a2f3a, roughness: 0.7 });
    visorMat ??= new THREE.MeshStandardNodeMaterial({ color: 0x111111, emissive: 0x40c0ff, emissiveIntensity: 1.2 });
    const g = new THREE.Group();
    const team = new THREE.MeshStandardNodeMaterial({ color, roughness: 0.6 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.38, 0.75, 4, 10), team); body.position.y = 0.9; g.add(body);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.42, 0.46), team); head.position.y = 1.62; g.add(head);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.13, 0.05), visorMat);
    visor.position.set(0, 1.66, -0.24); g.add(visor);
    const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.8, 8), dark); gun.rotation.x = Math.PI / 2; gun.position.set(0.36, 1.25, -0.25); g.add(gun);
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.5, 0.2), dark); legL.position.set(-0.15, 0.25, 0); g.add(legL);
    const legR = legL.clone(); legR.position.x = 0.15; g.add(legR);
    g.traverse(o => { if(o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return { group: g, gun, legs: [legL, legR] };
}
