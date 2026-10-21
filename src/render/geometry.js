/** Turn a mesher result ({ positions, normals, ao, materials, indices }) into a THREE.BufferGeometry with the attributes
 *  the terrain material reads: position, normal, ao (float), mat (float material id). */
import * as THREE from 'three/webgpu';

export function geometryFromMesh(mesh) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
    g.setAttribute('ao', new THREE.BufferAttribute(mesh.ao, 1));
    g.setAttribute('mat', new THREE.BufferAttribute(Float32Array.from(mesh.materials), 1));
    g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    g.computeBoundingSphere();
    return g;
}
