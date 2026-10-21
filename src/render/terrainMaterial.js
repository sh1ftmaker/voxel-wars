/** Terrain material: triplanar textures from the terrain texture array (TerrainTextures), per material id a layer,
 *  scale and tint, blended between the two materials of a triangle (geometry attribute `matBlend` = (A, B, blend),
 *  see surfaceNets.js) with a height-like bias from the textures' brightness so seams look like grout and grass tufts
 *  rather than a linear fade. Ambient occlusion from the mesher (attribute `ao`) darkens indirect light fully and the
 *  albedo a little.
 *
 *  createTerrainMaterial()               chunks: triplanar in world space
 *  createTerrainMaterial({ local: true }) detached bodies: triplanar in object space, so the texture rides along
 *                                         with a moving, rotating piece (build its geometry with geometryFromMesh).
 *
 *  Wood follows its grain (material ids 10/14/15, props.w = grain axis + 1): the plank texture's u axis runs along the
 *  grain on the two projections that see the fibres side on.
 *  Fresh breaks: `markFresh(center, radius)` (Destruction calls it for every carve; fracture code may too) tints the
 *  surface inside that sphere with the material's `fresh` colour (raw wood, light stone, dark wet soil), fading over
 *  FRESH_LIFE s. Up to FRESH_SLOTS spheres at once (oldest replaced); one short loop per vertex, skipped when none.
 *  Glass (id 16): meshPrep puts glass-only triangles in a second draw group; `meshMaterial(base, geometry)` returns
 *  [base, glass] for such meshes. The glass material is cheap: alpha blended, fresnel opacity, a sky-tinted rim. */
import * as THREE from 'three/webgpu';
import { attribute, texture, textureLoad, positionWorld, positionLocal, normalWorld, normalLocal, normalView, positionViewDirection, float, int, ivec2, vec3, mix, clamp, dot, select, uniform, varying, Fn, Loop, If, max, abs, pow } from 'three/tsl';
import { MATERIALS, GLASS, MAT_SLOTS } from '../voxel/materials.js';
import { terrainTextures } from './TerrainTextures.js';

const LUMA = vec3(0.2126, 0.7152, 0.0722);
let tables = null;
const FRESH_SLOTS = 16, FRESH_LIFE = 20;
// Per-material tables and the fresh marks live in one small float texture, uploaded only when something changes
// (uniform arrays are re-sent with every draw call: a 32-entry one cost ~0.5 ms a frame over ~300 chunk draws):
//   row 0: mark centre + radius, row 1: mark time, row 2: each material's fresh colour, row 3: tint (linear RGB),
//   row 4: props (texture layer, tiles per metre, glow, grain axis + 1)
const FW = Math.max(FRESH_SLOTS, MAT_SLOTS);
const fresh = { data: new Float32Array(FW * 5 * 4), tex: null, next: 0, last: -1e9 };
for(let i = 0; i < FRESH_SLOTS; i++) { fresh.data[i * 4 + 1] = -1e4; fresh.data[(FW + i) * 4] = -1e4; }
for(let i = 0; i < MAT_SLOTS; i++) fresh.data.set([...(MATERIALS[i]?.fresh || [1, 1, 1]), 0], (2 * FW + i) * 4);
fresh.tex = new THREE.DataTexture(fresh.data, FW, 5, THREE.RGBAFormat, THREE.FloatType);
fresh.tex.minFilter = fresh.tex.magFilter = THREE.NearestFilter;
fresh.tex.generateMipmaps = false;
fresh.tex.needsUpdate = true;
const clock = () => performance.now() / 1000;

/** Tint the surface inside a sphere (world metres) as a fresh break for FRESH_LIFE seconds. */
export function markFresh(center, radius) {
    const i = fresh.next; fresh.next = (i + 1) % FRESH_SLOTS;
    fresh.data.set([center[0], center[1], center[2], radius], i * 4);
    fresh.data[(FW + i) * 4] = fresh.last = clock();
    fresh.tex.needsUpdate = true;
}

export function createTerrainMaterial({ local = false } = {}) {
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 });
    // terrain is closed solid: cast shadows with front faces (back faces leak light at the foot of walls)
    mat.shadowSide = THREE.FrontSide;
    buildTerrainNodes(mat, { local });
    return mat;
}

/**
 * Soft ground (src/soft): deform chunk meshes in the vertex stage. `deform(skip)` (called inside the vertex
 * Fn) returns TSL { position (local), normal (local), rest (world position before deformation) }; `skip` is a
 * per-object int uniform (bits from `object.geometry.userData.softSkip`) that the deform provider may use to leave
 * meshes out. Textures follow the rest position, so they ride along with the wobble. WebGPU only: do not call
 * this on the WebGL2 backend (storage buffers in the vertex stage).
 */
export function enableTerrainDeform(mat, deform) {
    buildTerrainNodes(mat, { local: false, deform });
    mat.needsUpdate = true;
}

function buildTerrainNodes(mat, { local, deform = null }) {
    const tt = terrainTextures();
    if(!tables) {
        // props.w: wood grain axis + 1 (0: no grain; the default projections already run planks along x)
        for(let i = 0; i < tt.props.length; i++) { const g = MATERIALS[i]?.grain ?? -1; tt.props[i].w = g >= 0 ? g + 1 : 0; }
        // tints change once the textures have loaded (TerrainTextures._load)
        const sync = () => {
            for(let i = 0; i < MAT_SLOTS; i++) {
                const c = tt.tints[i], p = tt.props[i];
                fresh.data.set([c.r, c.g, c.b, 1], (3 * FW + i) * 4);
                fresh.data.set([p.x, p.y, p.z, p.w], (4 * FW + i) * 4);
            }
            fresh.tex.needsUpdate = true;
        };
        sync(); tt.ready.then(sync);
        tables = {
            // FRESH_SLOTS while any mark can still show, else 0 (the loop is skipped)
            count: uniform(0, 'int').onFrameUpdate(() => clock() - fresh.last < FRESH_LIFE ? FRESH_SLOTS : 0),
            now: uniform(0).onFrameUpdate(clock) };
    }
    let pWorld = positionWorld, nWorld = normalWorld;
    if(deform) {
        const skip = uniform(0, 'int').onObjectUpdate(({ object }) => object.geometry?.userData.softSkip | 0);
        const vRest = varying(vec3(0), 'vSoftRest');
        mat.positionNode = Fn(() => {
            const d = deform(skip);
            vRest.assign(d.rest);
            normalLocal.assign(d.normal);
            return d.position;
        })();
        pWorld = vRest;
    } else mat.positionNode = null;
    const mb = attribute('matBlend', 'vec3');
    const ia = mb.x.add(0.5).toInt(), ib = mb.y.add(0.5).toInt();
    const pa = textureLoad(fresh.tex, ivec2(ia, 4)), pb = textureLoad(fresh.tex, ivec2(ib, 4));
    const p = local ? positionLocal : pWorld;
    const nAbs = (local ? normalLocal : nWorld).abs();
    const n4 = nAbs.mul(nAbs).mul(nAbs).mul(nAbs);
    const w = n4.div(n4.x.add(n4.y).add(n4.z).max(1e-5));
    const tri = (props) => {
        const layer = props.x.add(0.5).toInt();
        const q = p.mul(props.y);
        // grain y (w = 2) or z (w = 3): turn the projections that see the fibres side on
        const gy = props.w.greaterThan(1.5).and(props.w.lessThan(2.5)), gz = props.w.greaterThan(2.5);
        const sx = texture(tt.texture, select(gy, q.yz, q.zy)).depth(layer).rgb;
        const sy = texture(tt.texture, select(gz, q.zx, q.xz)).depth(layer).rgb;
        const sz = texture(tt.texture, select(gy, q.yx, q.xy)).depth(layer).rgb;
        return sx.mul(w.x).add(sy.mul(w.y)).add(sz.mul(w.z));
    };
    const ca = tri(pa).mul(textureLoad(fresh.tex, ivec2(ia, 3)).rgb);
    const blend = mb.z;
    // second material only where the triangle mixes two (the branch is uniform across most triangles)
    const cb = tri(pb).mul(textureLoad(fresh.tex, ivec2(ib, 3)).rgb);
    // height blend: brighter texels of the incoming material win earlier
    const hb = clamp(blend.sub(0.5).mul(2.5).add(dot(cb, LUMA).sub(dot(ca, LUMA)).mul(0.8)).add(0.5), 0, 1);
    const wb = select(ia.equal(ib), float(0), hb);
    const albedo0 = mix(ca, cb, wb);
    // fresh breaks: the strongest live mark around this point (world space, also for bodies: a crack's mark is where
    // it happened), per vertex (the marks' edges fade over 0.25 m, wider than a mesh cell)
    const pw = positionWorld;
    const freshK = varying(Fn(() => {
        const k = float(0).toVar();
        Loop(tables.count, ({ i }) => {
            const sph = textureLoad(fresh.tex, ivec2(i, 0));
            const age = tables.now.sub(textureLoad(fresh.tex, ivec2(i, 1)).x);
            const inside = clamp(sph.w.add(0.35).sub(pw.sub(sph.xyz).length()).mul(4), 0, 1);
            const life = clamp(age.div(FRESH_LIFE).oneMinus(), 0, 1);
            k.assign(max(k, inside.mul(life.mul(life))));
        });
        return k;
    })(), 'vFresh');
    const freshTint = mix(textureLoad(fresh.tex, ivec2(ia, 2)).rgb, textureLoad(fresh.tex, ivec2(ib, 2)).rgb, wb);
    const albedo = albedo0.mul(mix(vec3(1), freshTint, freshK));
    const ao = attribute('ao', 'float');
    mat.colorNode = albedo.mul(mix(float(0.7), float(1), ao));
    mat.aoNode = mix(float(0.2), float(1), ao.mul(ao));
    const glow = mix(pa.z, pb.z, wb);
    mat.emissiveNode = albedo.mul(glow.mul(2.5));
    mat.userData.terrainSpace = local ? 'local' : 'world';
    mat.userData.textures = tt;
    if(mat.userData.glass) { mat.userData.glass.positionNode = mat.positionNode; mat.userData.glass.needsUpdate = true; }
}

/** The glass material paired with a terrain material (same vertex stage: soft-ground or soft-debris deformation). */
export function glassMaterialFor(base) {
    let g = base.userData.glass;
    if(g) { if(g.positionNode !== base.positionNode) { g.positionNode = base.positionNode; g.needsUpdate = true; } return g; }
    g = base.userData.glass = new THREE.MeshStandardNodeMaterial({ roughness: 0.04, metalness: 0, transparent: true, depthWrite: false });
    const tint = new THREE.Color(MATERIALS[GLASS].color);
    const facing = abs(dot(normalView, positionViewDirection));
    const rim = pow(float(1).sub(facing), 3);
    g.colorNode = vec3(tint.r, tint.g, tint.b).mul(0.6);
    g.opacityNode = mix(float(0.22), float(0.85), rim);
    g.emissiveNode = vec3(0.55, 0.68, 0.8).mul(rim.mul(0.6)); // the sky in the rim, a cheap reflection
    g.positionNode = base.positionNode;
    g.shadowSide = THREE.FrontSide;
    return g;
}
/** The material (or [terrain, glass] for meshes with a glass draw group) for a mesh with terrain geometry. */
export function meshMaterial(base, geometry) { return geometry.groups.length ? [base, glassMaterialFor(base)] : base; }

/** Resolves when the terrain textures have loaded (the material shows flat material colours until then). */
export function terrainTexturesReady() { return terrainTextures().ready; }
