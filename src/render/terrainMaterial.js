/** Terrain material: triplanar textures from the terrain texture array (TerrainTextures), per material id a layer,
 *  scale and tint, blended between the two materials of a triangle (geometry attribute `matBlend` = (A, B, blend),
 *  see surfaceNets.js) with a height-like bias from the textures' brightness so seams look like grout and grass tufts
 *  rather than a linear fade. Ambient occlusion from the mesher (attribute `ao`) darkens indirect light fully and the
 *  albedo a little.
 *
 *  createTerrainMaterial()               chunks: triplanar in world space
 *  createTerrainMaterial({ local: true }) detached bodies: triplanar in object space, so the texture rides along
 *                                         with a moving, rotating piece (build its geometry with geometryFromMesh). */
import * as THREE from 'three/webgpu';
import { attribute, uniformArray, texture, positionWorld, positionLocal, normalWorld, normalLocal, float, vec3, mix, clamp, dot, select } from 'three/tsl';
import { terrainTextures } from './TerrainTextures.js';

const LUMA = vec3(0.2126, 0.7152, 0.0722);
let tables = null;

export function createTerrainMaterial({ local = false } = {}) {
    const tt = terrainTextures();
    tables ||= { tints: uniformArray(tt.tints, 'color'), props: uniformArray(tt.props, 'vec4') };
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 });
    // terrain is closed solid: cast shadows with front faces (back faces leak light at the foot of walls)
    mat.shadowSide = THREE.FrontSide;
    const mb = attribute('matBlend', 'vec3');
    const ia = mb.x.add(0.5).toInt(), ib = mb.y.add(0.5).toInt();
    const pa = tables.props.element(ia), pb = tables.props.element(ib);
    const p = local ? positionLocal : positionWorld;
    const nAbs = (local ? normalLocal : normalWorld).abs();
    const n4 = nAbs.mul(nAbs).mul(nAbs).mul(nAbs);
    const w = n4.div(n4.x.add(n4.y).add(n4.z).max(1e-5));
    const tri = (props) => {
        const layer = props.x.add(0.5).toInt();
        const q = p.mul(props.y);
        const sx = texture(tt.texture, q.zy).depth(layer).rgb;
        const sy = texture(tt.texture, q.xz).depth(layer).rgb;
        const sz = texture(tt.texture, q.xy).depth(layer).rgb;
        return sx.mul(w.x).add(sy.mul(w.y)).add(sz.mul(w.z));
    };
    const ca = tri(pa).mul(vec3(tables.tints.element(ia)));
    const blend = mb.z;
    // second material only where the triangle mixes two (the branch is uniform across most triangles)
    const cb = tri(pb).mul(vec3(tables.tints.element(ib)));
    // height blend: brighter texels of the incoming material win earlier
    const hb = clamp(blend.sub(0.5).mul(2.5).add(dot(cb, LUMA).sub(dot(ca, LUMA)).mul(0.8)).add(0.5), 0, 1);
    const wb = select(ia.equal(ib), float(0), hb);
    const albedo = mix(ca, cb, wb);
    const ao = attribute('ao', 'float');
    mat.colorNode = albedo.mul(mix(float(0.7), float(1), ao));
    mat.aoNode = mix(float(0.2), float(1), ao.mul(ao));
    const glow = mix(pa.z, pb.z, wb);
    mat.emissiveNode = albedo.mul(glow.mul(2.5));
    mat.userData.terrainSpace = local ? 'local' : 'world';
    mat.userData.textures = tt;
    return mat;
}

/** Resolves when the terrain textures have loaded (the material shows flat material colours until then). */
export function terrainTexturesReady() { return terrainTextures().ready; }
