/**
 * Sky, sun, ambient light and fog: a bright, saturated daytime look.
 *
 *  - Sky: a dome that follows the camera, an analytic gradient (zenith blue to a pale horizon), a sun disk with glow and
 *    a soft cloud layer from a small tiling noise texture made at startup (one texture fetch per sky pixel).
 *  - Fog uses the sky's horizon colour so distant terrain melts into the sky.
 *  - Sun shadows follow the camera: the shadow camera is a box of SHADOW_HALF metres around a point a little ahead of
 *    the viewer, snapped to whole shadow texels so edges do not crawl as the camera moves. Phones get a smaller map.
 *
 * `new Environment({ scene, camera, renderer })`; call `update()` every frame (it is a system: ctx.addSystem(env)).
 * `env.sun` is the DirectionalLight (ctx.sun), `env.hemi` the HemisphereLight, `env.sunDir` the unit vector to the sun.
 */
import * as THREE from 'three/webgpu';
import { positionLocal, uniform, color, texture, vec2, vec3, float, mix, smoothstep, max, pow, dot } from 'three/tsl';
import { isMobile } from './device.js';

const ZENITH = new THREE.Color(0x2a78e0);
const HORIZON = new THREE.Color(0xb6daf5);
const GROUND = new THREE.Color(0xb9cfdc);
const SUN_COLOR = new THREE.Color(0xfff2dc);

/** Recommended renderer settings for this device (pixel ratio cap and shadow map size). */
export const quality = {
    pixelRatio: isMobile ? 1.25 : 1.5,
    shadowMapSize: isMobile ? 2048 : 4096,
    shadowHalf: isMobile ? 32 : 48,
};

/** Apply the device's pixel ratio, tone mapping and shadow settings to a renderer. */
export function configureRenderer(renderer) {
    renderer.setPixelRatio(Math.min(devicePixelRatio, quality.pixelRatio));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
}

export class Environment {
    constructor({ scene, camera }) {
        this.scene = scene;
        this.camera = camera;
        this.sunDir = new THREE.Vector3(0.36, 0.7, 0.6).normalize();

        scene.background = HORIZON.clone();
        scene.fog = new THREE.Fog(HORIZON.clone(), 70, 330);

        this.hemi = new THREE.HemisphereLight(0xcfe4ff, 0x8d7a5c, 1.35);
        scene.add(this.hemi);

        const sun = this.sun = new THREE.DirectionalLight(SUN_COLOR, 3.2);
        sun.castShadow = true;
        sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
        const H = this.shadowHalf = quality.shadowHalf;
        Object.assign(sun.shadow.camera, { left: -H, right: H, top: H, bottom: -H, near: 1, far: 260 });
        sun.shadow.bias = -0.0004;
        sun.shadow.normalBias = 0.04;
        sun.shadow.radius = 2;
        scene.add(sun, sun.target);

        this.sky = this._sky();
        scene.add(this.sky);
        this._focus = new THREE.Vector3();
        this._fwd = new THREE.Vector3();
        this.update();
    }

    _sky() {
        const dir = positionLocal.normalize();
        const y = dir.y;
        const sunDir = this.sunDirUniform = uniform(this.sunDir.clone());
        const up = max(y, 0);
        let col = mix(color(HORIZON), color(ZENITH), pow(up, 0.55));
        col = mix(col, color(GROUND), smoothstep(0, 0.25, y.negate()));
        // clouds: a tiling noise texture projected on a high plane
        const cuv = dir.xz.div(y.add(0.12)).mul(0.22).add(vec2(0.31, 0.17));
        const n = texture(cloudTexture(), cuv).r;
        const cloud = smoothstep(0.5, 0.78, n).mul(smoothstep(0.02, 0.22, y)).mul(0.85);
        const cloudCol = mix(vec3(0.82, 0.86, 0.93), vec3(1.15, 1.15, 1.15), smoothstep(0.55, 0.9, n));
        col = mix(col, cloudCol, cloud);
        // sun: disk and glow
        const s = max(dot(dir, sunDir), 0);
        const glow = pow(s, 12).mul(0.25).add(pow(s, 220).mul(0.6));
        const disk = smoothstep(0.99935, 0.9997, s).mul(float(1).sub(cloud.mul(0.8))).mul(18);
        col = col.add(color(SUN_COLOR).mul(glow.add(disk)));
        const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
        m.colorNode = col;
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(440, 32, 16), m);
        mesh.name = 'sky';
        mesh.frustumCulled = false;
        mesh.renderOrder = -1000;
        mesh.castShadow = mesh.receiveShadow = false;
        return mesh;
    }

    update() {
        const cam = this.camera, sun = this.sun, H = this.shadowHalf;
        this.sky.position.copy(cam.position);
        this.sunDirUniform.value.copy(this.sunDir);
        // shadow focus: where the view ray meets the ground (y = 1), at most SHADOW_HALF/2 ahead of the camera
        const fw = cam.getWorldDirection(this._fwd);
        let t = H * 0.5;
        if(fw.y < -0.02) t = Math.min(t, Math.max(0, (cam.position.y - 1) / -fw.y));
        const f = this._focus.copy(cam.position).addScaledVector(fw, t);
        // snap to shadow texels in light space
        const z = this.sunDir, x = _x.set(0, 1, 0).cross(z).normalize(), yv = _y.copy(z).cross(x);
        const texel = (2 * H) / sun.shadow.mapSize.x;
        const lx = Math.round(f.dot(x) / texel) * texel, ly = Math.round(f.dot(yv) / texel) * texel, lz = f.dot(z);
        f.copy(x).multiplyScalar(lx).addScaledVector(yv, ly).addScaledVector(z, lz);
        sun.target.position.copy(f);
        sun.position.copy(f).addScaledVector(z, 130);
        sun.target.updateMatrixWorld();
        sun.updateMatrixWorld();
    }
}
const _x = new THREE.Vector3(), _y = new THREE.Vector3();

let clouds = null;
/** A 256² tiling value-noise fbm (R channel), made once. */
function cloudTexture() {
    if(clouds) return clouds;
    const N = 256, data = new Uint8Array(N * N * 4);
    const field = new Float32Array(N * N);
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    let amp = 1, total = 0;
    for(let cells = 4; cells <= 64; cells *= 2) {
        const g = new Float32Array(cells * cells).map(rnd);
        const step = N / cells;
        for(let y = 0; y < N; y++) for(let x = 0; x < N; x++) {
            const fx = x / step, fy = y / step, ix = Math.floor(fx), iy = Math.floor(fy);
            let tx = fx - ix, ty = fy - iy;
            tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
            const a = g[(iy % cells) * cells + ix % cells], b = g[(iy % cells) * cells + (ix + 1) % cells];
            const c = g[((iy + 1) % cells) * cells + ix % cells], d = g[((iy + 1) % cells) * cells + (ix + 1) % cells];
            field[y * N + x] += amp * ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty);
        }
        total += amp; amp *= 0.5;
    }
    for(let i = 0; i < N * N; i++) { const v = Math.round(field[i] / total * 255); data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v; data[i * 4 + 3] = 255; }
    clouds = new THREE.DataTexture(data, N, N);
    clouds.wrapS = clouds.wrapT = THREE.RepeatWrapping;
    clouds.magFilter = THREE.LinearFilter;
    clouds.minFilter = THREE.LinearMipmapLinearFilter;
    clouds.generateMipmaps = true;
    clouds.needsUpdate = true;
    return clouds;
}
