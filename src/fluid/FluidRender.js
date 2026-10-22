/**
 * Draws the fluid particles in one draw call: instanced camera-facing sprites shaded as sphere impostors (normal from
 * the sprite's uv, the sphere's depth written per fragment so the particles merge with each other and the terrain).
 * Water: a deep blue-green body lit by the sun, sky reflection by Fresnel, a sun glint, foam where it moves fast or
 * sprays thin. Lava: emissive orange under a darker crust that drifts over it (a world-space pattern, not per particle). Works on both backends: the
 * per-instance nodes come from the GPU solver's storage buffers or the CPU solver's instanced attributes.
 */
import * as THREE from 'three/webgpu';
import {
    Fn, If, Discard, uv, vec3, vec4, float, uniform, varying, select, mix, smoothstep, max, pow, dot, sqrt, normalize, reflect, length,
    positionView, cameraNear, cameraFar, viewZToPerspectiveDepth, cameraViewMatrix, cameraWorldMatrix, sin, time,
} from 'three/tsl';

export class FluidRender {
    constructor(scene, nodes, { spacing, count }) {
        const m = this.material = new THREE.SpriteNodeMaterial();
        m.transparent = false; m.depthWrite = true; m.depthTest = true;
        m.fog = true;
        this.sunDir = uniform(new THREE.Vector3(0.36, 0.7, 0.6).normalize());
        const P = nodes.pos;
        const phase = P.w;
        const diameter = spacing * 2.6;
        const dens = nodes.surf.w;
        const size = select(phase.equal(0), float(0), float(diameter).mul(select(dens.lessThan(0.45), float(0.7), float(1))));
        m.positionNode = P.xyz;
        m.scaleNode = size;
        const vLava = varying(select(phase.greaterThan(1.5), float(1), float(0)));
        const vSpeed = varying(nodes.speed), vDens = varying(dens), vSize = varying(size);
        // the fluid's surface normal at the particle (from the solver's density gradient): ~unit length at a free
        // surface, ~0 inside; in view space
        const vSurf = varying(cameraViewMatrix.mul(vec4(nodes.surf.xyz, 0)).xyz);
        // smooth variation over the world (not per particle: that speckles)
        const wp = P.xyz;
        const vNoise = varying(sin(wp.x.mul(2.3).add(time.mul(0.9))).mul(sin(wp.z.mul(2.9).sub(time.mul(0.7)))).mul(0.5).add(0.5)
            .mul(0.6).add(sin(wp.x.mul(0.9).sub(wp.z.mul(1.3)).add(time.mul(0.4))).mul(0.2).add(0.2)));
        const nView = Fn(() => {
            const c = uv().mul(2).sub(1).toVar();
            const r2 = dot(c, c).toVar();
            If(r2.greaterThan(1), () => { Discard(); });
            return vec3(c.x, c.y, sqrt(float(1).sub(r2)));
        })().toVar();
        // shade with the fluid's surface normal (up where it is unclear), a little of the ball's: the particles of a
        // pool read as one rippled sheet, a stream as a rope of water
        const upView = normalize(cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz);
        const sl = length(vSurf);
        const nFluid = normalize(mix(upView, vSurf.div(max(sl, 1e-4)), smoothstep(0.15, 0.6, sl)));
        const n = normalize(mix(nView, nFluid, mix(0.75, 0.85, vLava))).toVar();
        const v = normalize(positionView.negate()).toVar();
        const sunView = normalize(cameraViewMatrix.mul(vec4(this.sunDir, 0)).xyz).toVar();
        const ndl = max(dot(n, sunView), 0);
        const fres = float(0.06).add(pow(float(1).sub(max(dot(n, v), 0)), 5).mul(0.85));
        const r = reflect(v.negate(), n).toVar();
        const spec = pow(max(dot(r, sunView), 0), 90).mul(1.6);
        // water: a deep blue-green body, the sky reflected by Fresnel, foam where it runs fast or sprays thin
        const rWorld = cameraWorldMatrix.mul(vec4(r, 0)).xyz;
        const sky = mix(vec3(0.62, 0.78, 0.9), vec3(0.16, 0.42, 0.82), smoothstep(0.0, 0.7, rWorld.y));
        const deep = vec3(0.01, 0.07, 0.12), shallow = vec3(0.04, 0.22, 0.3);
        const body = mix(deep, shallow, ndl.mul(0.45).add(vNoise.mul(0.4)).clamp(0, 1));
        const foam = smoothstep(9, 16, vSpeed).mul(0.4).add(smoothstep(0.4, 0.15, vDens).mul(0.3)).clamp(0, 0.6);
        const water = mix(mix(body, sky, fres), vec3(0.85, 0.92, 0.97), foam).add(spec);
        // lava: emissive orange under a darker crust that drifts, hotter where it moves
        const heat = smoothstep(0.3, 0.85, vNoise).add(smoothstep(0.5, 3, vSpeed).mul(0.6)).mul(nView.z.mul(0.3).add(0.7)).clamp(0, 1);
        const lava = mix(vec3(0.16, 0.025, 0.01), vec3(1.35, 0.26, 0.02), heat).add(vec3(0.35, 0.14, 0.0).mul(heat.mul(heat).mul(heat))).add(spec.mul(0.1));
        m.colorNode = vec4(mix(water, lava, vLava), 1);
        // the sphere's depth
        m.depthNode = viewZToPerspectiveDepth(positionView.z.add(nView.z.mul(vSize.mul(0.35))), cameraNear, cameraFar);
        const s = this.sprite = new THREE.Sprite(m);
        s.count = Math.max(1, count);
        s.frustumCulled = false;
        s.castShadow = false; s.receiveShadow = false;
        s.renderOrder = 1;
        scene.add(s);
    }
    set count(n) { this.sprite.count = Math.max(1, n); this.sprite.visible = n > 0; }
}
