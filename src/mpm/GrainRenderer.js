/**
 * The grains, drawn in one instanced draw call: a small faceted rock per particle, sized by the matter it carries,
 * squashed and turned at random per grain, coloured by the terrain's own texture for its material (the texture array
 * of src/render/TerrainTextures.js, looked up from above at the grain's position, times the material tint), so a
 * pouring dune shows the dune's sand. Depth-tested and depth-written, lit, casting no shadow (cheap).
 *
 *   GPU backend:  new GrainRenderer(scene, { gpu: MpmGPU })   reads the solver's particle buffer and slot origins in
 *                 the vertex stage (no readback); instances = slots in use x PER_ZONE (dead ones collapse to nothing)
 *   CPU backend:  new GrainRenderer(scene, { cap, divisor })  an instanced attribute `grain` (world xyz, packed word)
 *                 the CPU solver's worker fills each frame: renderer.setCPU(data, n). The CPU solver carries fewer
 *                 particles per voxel (each one more matter), so every particle is drawn as up to 8 grains scattered
 *                 over its share of the voxel (an attribute divisor of 8 on WebGL2; copied 8 times elsewhere): the
 *                 ground pours as finely as on the GPU path
 */
import * as THREE from 'three/webgpu';
import { Fn, attribute, instanceIndex, int, float, vec3, texture, hash, select, varying, positionLocal, normalLocal, uniformArray } from 'three/tsl';
import { H, PER_ZONE } from './params.js';
import { terrainTextures } from '../render/TerrainTextures.js';

const SIZE = 0.13; // m: a grain carrying 1/8 voxel (the edge of a 1/8 voxel cube is 0.125 m)
const SUB = 8;     // CPU path: grains drawn per particle (at most)

export class GrainRenderer {
    constructor(scene, { gpu = null, cap = 0, divisor = true } = {}) {
        this.scene = scene;
        this.gpu = gpu;
        const geo = new THREE.OctahedronGeometry(0.5, 0);
        geo.deleteAttribute('uv');
        // rounded shading: vertex normals along the vertex directions (a pebble, not a crystal)
        const pa = geo.attributes.position, na = geo.attributes.normal;
        for(let i = 0; i < pa.count; i++) { const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i), l = Math.hypot(x, y, z); na.setXYZ(i, x / l, y / l, z / l); }
        this.divisor = divisor;
        if(!gpu) {
            this.data = new Float32Array(cap * 4 * (divisor ? 1 : SUB));
            this.attr = new THREE.InstancedBufferAttribute(this.data, 4, false, divisor ? SUB : 1);
            this.attr.setUsage(THREE.DynamicDrawUsage);
            geo.setAttribute('grain', this.attr);
        }
        const mat = this.material = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
        const tt = terrainTextures();
        // the terrain's own per-material tables (the tints change in place when the textures arrive)
        const uTints = uniformArray(tt.tints, 'color'), uProps = uniformArray(tt.props, 'vec4');
        const vCol = varying(vec3(0), 'vGrainCol');
        const vMat = varying(float(0), 'vGrainMat');
        const sim = gpu;
        mat.positionNode = Fn(() => {
            let centre, word;
            if(sim) {
                const P = sim.pos.element(instanceIndex).toVar();
                const slot = int(instanceIndex).div(PER_ZONE);
                const A = sim.params.element(slot).toVar(); // slotA rows come first in the parameter buffer
                const alive = P.w.greaterThanEqual(0).and(A.w.greaterThan(0.5));
                centre = select(alive, A.xyz.add(P.xyz).mul(H), vec3(0, -1e5, 0));
                word = select(alive, P.w, float(0));
            } else {
                const g = attribute('grain', 'vec4');
                centre = g.xyz; word = g.w;
            }
            const w = int(word).toVar();
            const m = w.bitAnd(31), ppcLog = w.shiftRight(5).bitAnd(3);
            vMat.assign(float(m));
            const id = float(instanceIndex);
            const r1 = hash(id.add(0.5)), r2 = hash(id.add(17.3)), r3 = hash(id.add(91.1));
            let size;
            if(sim) {
                // a grain the size of its matter (8 per voxel: 0.13 m; fewer per voxel: bigger), jittered
                size = float(SIZE).mul(float(1).add(float(ppcLog).mul(0.26))).mul(r1.mul(0.5).add(0.75));
            } else {
                // up to 8 grains per particle, scattered over its share of the voxel (2^ppcLog of the 8)
                const sub = int(instanceIndex).bitAnd(SUB - 1);
                const keep = sub.lessThan(int(1).shiftLeft(ppcLog));
                const spread = float(H * 0.5).mul(float(1).add(float(ppcLog).mul(0.26)));
                const jit = vec3(hash(id.add(5.1)), hash(id.add(9.7)), hash(id.add(13.3))).sub(0.5).mul(spread).mul(select(sub.equal(0), float(0), float(1)));
                centre = centre.add(jit);
                size = select(keep, float(SIZE).mul(r1.mul(0.5).add(0.75)), float(0));
            }
            const squash = vec3(r2.mul(0.5).add(0.8), r3.mul(0.4).add(0.6), r1.mul(0.5).add(0.8));
            // a cheap random turn (rotations only, so the faces keep their winding): a cyclic swap of the axes and a
            // half turn about y, by the hash
            const turn = (q) => select(r2.greaterThan(0.5), q.yzx, q).mul(select(r3.greaterThan(0.5), vec3(-1, 1, -1), vec3(1)));
            const p = turn(positionLocal.mul(squash));
            const n = turn(normalLocal.div(squash));
            normalLocal.assign(n.normalize());
            // colour: the material's terrain texture from above at the grain's spot (a coarse mip: one texel-ish
            // colour per grain), its tint, and a little brightness jitter per grain
            const pr = uProps.element(m), tint = vec3(uTints.element(m));
            const layer = pr.x.add(0.5).toInt();
            const tex = texture(tt.texture, centre.xz.mul(pr.y)).depth(layer).level(4).rgb;
            vCol.assign(tex.mul(tint).mul(hash(id.add(3.7)).mul(0.3).add(0.85)));
            return centre.add(p.mul(size));
        })();
        mat.colorNode = vCol;
        // lava glows like the terrain's lava
        mat.emissiveNode = vCol.mul(select(vMat.equal(7), float(2.5), float(0)));
        const mesh = this.mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false;
        mesh.castShadow = false; mesh.receiveShadow = true;
        mesh.count = 0;
        mesh.name = 'mpm grains';
        scene.add(mesh);
    }
    /** GPU: draw slots 0..maxSlot. */
    setSlots(maxSlot) { this.mesh.count = (maxSlot + 1) * PER_ZONE; this.mesh.visible = maxSlot >= 0; }
    /** CPU: n particles of world xyz + packed word (each drawn as up to 8 grains). */
    setCPU(data, n) {
        if(this.divisor) this.data.set(data.subarray(0, n * 4));
        else for(let p = 0; p < n; p++) for(let k = 0; k < SUB; k++) this.data.set(data.subarray(p * 4, p * 4 + 4), (p * SUB + k) * 4);
        this.attr.clearUpdateRanges?.();
        this.attr.addUpdateRange(0, n * 4 * (this.divisor ? 1 : SUB));
        this.attr.needsUpdate = true;
        this.mesh.count = n * SUB;
        this.mesh.visible = n > 0;
    }
}
