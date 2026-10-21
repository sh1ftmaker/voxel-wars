/** Terrain material: per-vertex material colour (palette lookup) darkened by the mesher's ambient occlusion.
 *  Placeholder for the triplanar texture array material. */
import * as THREE from 'three/webgpu';
import { attribute, uniformArray, vec3, int, float, mix } from 'three/tsl';
import { MATERIALS } from '../voxel/materials.js';

export function createTerrainMaterial() {
    const colors = MATERIALS.map(m => new THREE.Color(m.color));
    const palette = uniformArray(colors, 'color');
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
    const id = int(attribute('mat', 'float').add(0.5));
    const ao = attribute('ao', 'float');
    mat.colorNode = vec3(palette.element(id)).mul(mix(float(0.35), float(1), ao));
    return mat;
}
