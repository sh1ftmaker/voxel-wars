/** Turn a mesher result ({ positions, normals, ao, materials, materials2?, blend?, indices }) into a THREE.BufferGeometry
 *  with the attributes the terrain material reads: position, normal, ao (float), mat (float material id A) and matBlend
 *  (vec3: material A, material B, blend 0 = A .. 1 = B). Meshes without materials2/blend get B = A, blend = 0. */
import * as THREE from 'three/webgpu';

export function geometryFromMesh(mesh) {
    const g = new THREE.BufferGeometry();
    const n = mesh.positions.length / 3;
    g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
    g.setAttribute('ao', new THREE.BufferAttribute(mesh.ao, 1));
    // material ids as (A, B, blend) in one vec3 attribute; precomputed by the mesh worker (src/voxel/meshPrep.js)
    let m = mesh.matBlend, mf = mesh.matF;
    if(!m) {
        m = new Float32Array(n * 3);
        const A = mesh.materials, B = mesh.materials2 || A, W = mesh.blend;
        for(let i = 0; i < n; i++) { m[i * 3] = A[i]; m[i * 3 + 1] = B[i]; m[i * 3 + 2] = W ? W[i] : 0; }
        mf = Float32Array.from(A);
    }
    g.setAttribute('mat', new THREE.BufferAttribute(mf, 1)); // kept for other readers
    g.setAttribute('matBlend', new THREE.BufferAttribute(m, 3));
    g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    const b = mesh.bounds;
    if(b) {
        g.boundingBox = new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5]));
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(b[6], b[7], b[8]), b[9]);
    } else {
        g.computeBoundingSphere();
        g.computeBoundingBox();
    }
    // a terrain chunk's collider octants (Physics.setChunkCollider), when the worker made them
    if(mesh.octants) g.userData.octants = mesh.octants;
    return g;
}
