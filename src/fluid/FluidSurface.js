/**
 * Screen-space fluid surface (van der Laan et al. 2009, simplified): the particles are drawn as spheres into a
 * half-resolution float target holding the distance to the nearest sphere surface (plus lava and foam fractions), that
 * distance is smoothed by a separable bilateral filter, and a full-screen triangle in the main scene reconstructs the
 * surface's normals from the smoothed distance and shades it as water or lava, writing its depth so the terrain hides
 * it where it should. The particles are one draw call; the surface adds three full-screen passes (two at half size).
 *
 *   const s = new FluidSurface(ctx, nodes, { spacing })   nodes: { pos (xyz, phase), surf (normal, density), speed }
 *   s.render(inView)  before the main render each frame (Fluid.update): the depth pass and the blur (skipped, and the
 *                     surface hidden, when no fluid is in view)
 *   s.count = n       particles drawn;  s.visible = false hides it
 */
import * as THREE from 'three/webgpu';
import {
    Fn, If, Loop, Continue, Discard, uv, int, vec2, vec3, vec4, float, uniform, varying, select, mix, smoothstep, max, min, pow, dot, sqrt, normalize,
    reflect, length, abs, exp, cross, floor, texture, screenUV, positionView, positionGeometry, cameraNear, cameraFar, viewZToPerspectiveDepth,
    cameraViewMatrix, cameraWorldMatrix, sin, time,
} from 'three/tsl';

const SCALE = 0.5;   // the depth targets' size relative to the drawing buffer
const MAXR = 16;     // bilateral filter radius cap (texels, per pass)

export class FluidSurface {
    constructor(ctx, nodes, { spacing }) {
        this.ctx = ctx;
        this.renderer = ctx.renderer;
        this.camera = ctx.camera;
        this.sunDir = uniform(new THREE.Vector3(0.36, 0.7, 0.6).normalize());
        this.fogColor = uniform(new THREE.Color(0xb6daf5));
        this.fogRange = uniform(new THREE.Vector2(70, 330));
        this.proj = uniform(new THREE.Vector2(1, 1));       // projection matrix [0][0], [1][1]
        this.texel = uniform(new THREE.Vector2(1, 1));      // 1 / target size
        this.blurDir = [uniform(new THREE.Vector2(1, 0)), uniform(new THREE.Vector2(0, 1))];
        this.radius = spacing * 0.5;
        const opts = { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false };
        this.rtDepth = new THREE.RenderTarget(1, 1, { ...opts, depthBuffer: true });
        this.rtBlur = [new THREE.RenderTarget(1, 1, { ...opts, depthBuffer: false }), new THREE.RenderTarget(1, 1, { ...opts, depthBuffer: false })];
        for(const rt of [this.rtDepth, ...this.rtBlur]) rt.texture.colorSpace = THREE.NoColorSpace;

        // ---- 1) spheres: distance to the camera of the nearest sphere surface, lava fraction, foam
        const P = nodes.pos, phase = P.w, dens = nodes.surf.w;
        const diameter = spacing * 2.2;
        const size = select(phase.equal(0), float(0), float(diameter).mul(select(dens.lessThan(0.45), float(0.75), float(1))));
        const dm = this.depthMaterial = new THREE.SpriteNodeMaterial();
        dm.transparent = false; dm.depthWrite = true; dm.depthTest = true; dm.fog = false; dm.toneMapped = false;
        dm.positionNode = P.xyz;
        dm.scaleNode = size;
        const vLava = varying(select(phase.greaterThan(1.5), float(1), float(0)));
        // foam: fast water, and spray (isolated and moving; a thin film at rest is just shallow water)
        const vFoam = varying(smoothstep(8, 15, nodes.speed).mul(0.5).add(smoothstep(0.3, 0.1, dens).mul(smoothstep(1.5, 5, nodes.speed)).mul(0.4)).clamp(0, 0.7));
        const vSize = varying(size);
        const nz = Fn(() => {
            const c = uv().mul(2).sub(1).toVar();
            const r2 = dot(c, c).toVar();
            If(r2.greaterThan(1), () => { Discard(); });
            return sqrt(float(1).sub(r2));
        })().toVar();
        const z = positionView.z.add(nz.mul(vSize.mul(0.5))).toVar();
        dm.colorNode = vec4(z.negate(), vLava, vFoam, 1);
        dm.depthNode = viewZToPerspectiveDepth(z, cameraNear, cameraFar);
        this.sprite = new THREE.Sprite(dm);
        this.sprite.frustumCulled = false;
        this.scene = new THREE.Scene();
        this.scene.add(this.sprite);

        // ---- 2) separable bilateral filter of the distance (r); lava and foam (g, b) are averaged alongside
        const R = this.radius;
        const blur = (src, dir) => Fn(() => {
            const c = texture(src.texture, uv()).toVar();
            If(c.r.lessThanEqual(0), () => { Discard(); });
            // a Gaussian over ~2 particle radii on screen (every texel: sparse taps alias into stripes), at most MAXR
            const pxPerM = this.proj.y.mul(0.5).div(this.texel.y).div(c.r);
            const rad = int(min(float(MAXR), max(float(1), pxPerM.mul(R * 4)))).toVar();
            const negInv = float(-2).div(float(rad.mul(rad))).toVar(); // exp(-k^2 / (2 sigma^2)), sigma = rad / 2
            const sumD = c.r.toVar(), sumC = c.yz.toVar(), wsum = float(1).toVar();
            const sigR = float(R * 6);
            Loop({ start: rad.negate(), end: rad, type: 'int', condition: '<=', name: 'k' }, ({ k }) => {
                If(k.equal(0), () => { Continue(); });
                const s = texture(src.texture, uv().add(dir.mul(this.texel).mul(float(k)))).toVar();
                const ws = exp(float(k.mul(k)).mul(negInv));
                const dz = s.r.sub(c.r);
                const w = select(s.r.greaterThan(0), exp(dz.mul(dz).div(sigR.mul(sigR).mul(-2))).mul(ws), float(0));
                sumD.addAssign(s.r.mul(w)); sumC.addAssign(s.yz.mul(w)); wsum.addAssign(w);
            });
            return vec4(sumD.div(wsum), sumC.div(wsum), 1);
        })();
        this.blurQuad = [new THREE.QuadMesh(new THREE.MeshBasicNodeMaterial()), new THREE.QuadMesh(new THREE.MeshBasicNodeMaterial())];
        this.blurQuad[0].material.colorNode = blur(this.rtDepth, this.blurDir[0]);
        this.blurQuad[1].material.colorNode = blur(this.rtBlur[0], this.blurDir[1]);
        for(const q of this.blurQuad) { q.material.toneMapped = false; q.material.depthTest = false; q.material.depthWrite = false; }

        // ---- 3) the surface, in the main scene: a full-screen triangle, depth-tested against the terrain
        const src = this.rtBlur[1].texture;
        const viewPos = (suv, d) => vec3(suv.x.mul(2).sub(1).mul(d).div(this.proj.x), float(1).sub(suv.y.mul(2)).mul(d).div(this.proj.y), d.negate());
        const sm = this.material = new THREE.MeshBasicNodeMaterial();
        sm.fog = false; sm.depthTest = true; sm.depthWrite = true; sm.transparent = false;
        sm.vertexNode = vec4(positionGeometry.xy, 0, 1);
        // the smoothed distance between texel centres (bilinear by hand over the texels that hold fluid: float targets
        // are not filterable everywhere), so normals vary per screen pixel instead of in half-size blocks
        const dist = (q, fallback) => {
            const t = q.div(this.texel).sub(0.5).toVar();
            const i0 = floor(t).toVar(), f = t.sub(i0).toVar();
            const at = (a, b) => texture(src, i0.add(vec2(a, b)).add(0.5).mul(this.texel)).r;
            const s00 = at(0, 0).toVar(), s10 = at(1, 0).toVar(), s01 = at(0, 1).toVar(), s11 = at(1, 1).toVar();
            const w00 = f.x.oneMinus().mul(f.y.oneMinus()).mul(select(s00.greaterThan(0), 1, 0));
            const w10 = f.x.mul(f.y.oneMinus()).mul(select(s10.greaterThan(0), 1, 0));
            const w01 = f.x.oneMinus().mul(f.y).mul(select(s01.greaterThan(0), 1, 0));
            const w11 = f.x.mul(f.y).mul(select(s11.greaterThan(0), 1, 0));
            const ws = w00.add(w10).add(w01).add(w11).toVar();
            return select(ws.greaterThan(1e-4), s00.mul(w00).add(s10.mul(w10)).add(s01.mul(w01)).add(s11.mul(w11)).div(max(ws, 1e-4)), fallback);
        };
        const shade = Fn(() => {
            const suv = floor(screenUV.div(this.texel)).add(0.5).mul(this.texel).toVar(); // the centre of its texel
            const c = texture(src, suv).toVar();
            If(c.r.lessThanEqual(0), () => { Discard(); });
            const d = dist(screenUV, c.r).toVar();
            // normal from the neighbouring pixels: the smaller difference on each axis (keeps silhouettes from smearing)
            const px1 = vec2(this.texel.x.mul(SCALE), 0), py1 = vec2(0, this.texel.y.mul(SCALE));
            const p0 = viewPos(screenUV, d).toVar();
            // (a side with no fluid does not count: at a silhouette the other side's difference is used)
            const dxp = dist(screenUV.add(px1), float(0)).toVar(), dxn = dist(screenUV.sub(px1), float(0)).toVar();
            const dyp = dist(screenUV.add(py1), float(0)).toVar(), dyn = dist(screenUV.sub(py1), float(0)).toVar();
            const px = viewPos(screenUV.add(px1), select(dxp.greaterThan(0), dxp, d)).sub(p0).toVar();
            const nx = p0.sub(viewPos(screenUV.sub(px1), select(dxn.greaterThan(0), dxn, d))).toVar();
            const py = viewPos(screenUV.add(py1), select(dyp.greaterThan(0), dyp, d)).sub(p0).toVar();
            const ny = p0.sub(viewPos(screenUV.sub(py1), select(dyn.greaterThan(0), dyn, d))).toVar();
            const pick = (a, b, va, vb) => select(va.and(vb.not().or(abs(a.z).lessThan(abs(b.z)))), a, b);
            const ddx = pick(px, nx, dxp.greaterThan(0), dxn.greaterThan(0));
            const ddy = pick(py, ny, dyp.greaterThan(0), dyn.greaterThan(0));
            const n = normalize(cross(ddx, ddy)).toVar();
            const v = normalize(p0.negate()).toVar();
            If(dot(n, v).lessThan(0), () => { n.assign(n.negate()); }); // toward the eye
            const sunView = normalize(cameraViewMatrix.mul(vec4(this.sunDir, 0)).xyz).toVar();
            const r = reflect(v.negate(), n).toVar();
            const ndl = max(dot(n, sunView), 0);
            // (|n.v|: a wave face turned a little away from the eye, as reconstructed, is not a mirror)
            const fres = float(0.05).add(pow(float(1).sub(abs(dot(n, v))), 5).mul(0.6));
            const rs = max(dot(r, sunView), 0);
            const spec = pow(rs, 400).mul(1.2).add(pow(rs, 40).mul(0.12));
            const lava = c.g, foam = c.b;
            // a slow world-space pattern for the lava crust and a little variation in the water
            const wpos = cameraWorldMatrix.mul(vec4(p0, 1)).xyz;
            const noise = sin(wpos.x.mul(2.3).add(time.mul(0.9))).mul(sin(wpos.z.mul(2.9).sub(time.mul(0.7)))).mul(0.25).add(0.25)
                .add(sin(wpos.x.mul(0.9).sub(wpos.z.mul(1.3)).add(time.mul(0.4))).mul(0.17).add(0.17))
                .add(sin(wpos.x.mul(6.1).add(wpos.z.mul(3.7)).add(time.mul(1.3))).mul(sin(wpos.z.mul(5.3).sub(wpos.x.mul(2.2)).sub(time))).mul(0.08).add(0.08));
            // water: a deep blue-green body, the sky reflected by Fresnel, a sun glint, foam
            const rWorld = cameraWorldMatrix.mul(vec4(r, 0)).xyz;
            const sky = mix(vec3(0.5, 0.66, 0.8), vec3(0.16, 0.42, 0.82), smoothstep(0.0, 0.7, rWorld.y));
            const body = mix(vec3(0.01, 0.06, 0.1), vec3(0.04, 0.2, 0.27), ndl.mul(0.5).add(noise.mul(0.3)).clamp(0, 1));
            const water = mix(mix(body, sky, fres), vec3(0.85, 0.92, 0.97), foam).add(spec);
            // lava: emissive orange under a darker crust that drifts
            const heat = smoothstep(0.3, 0.85, noise).mul(n.z.mul(0.3).add(0.7)).clamp(0, 1);
            const hot = mix(vec3(0.16, 0.025, 0.01), vec3(1.35, 0.26, 0.02), heat).add(vec3(0.35, 0.14, 0.0).mul(heat.mul(heat).mul(heat))).add(spec.mul(0.1));
            const col = mix(water, hot, smoothstep(0.3, 0.7, lava));
            // fog as the scene's
            const f = smoothstep(this.fogRange.x, this.fogRange.y, d);
            return vec4(mix(col, this.fogColor, f), 1);
        });
        sm.colorNode = shade();
        sm.depthNode = Fn(() => viewZToPerspectiveDepth(texture(src, screenUV).r.negate(), cameraNear, cameraFar))();
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
        this.mesh = new THREE.Mesh(g, sm);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 2; // after the opaque terrain (it only covers what it is in front of)
        ctx.scene.add(this.mesh);
        this._size = new THREE.Vector2();
        this._clear = new THREE.Color();
        this.visible = true;
    }
    set count(n) { this.sprite.count = Math.max(1, n); this.n = n; }

    /** The depth pass and the blur, before the main render; `inView` false (no fluid in the frustum) skips them all. */
    render(inView = true) {
        const r = this.renderer, cam = this.camera;
        this.mesh.visible = this.visible && inView && this.n > 0;
        if(!this.mesh.visible) return;
        r.getDrawingBufferSize(this._size);
        const w = Math.max(1, Math.floor(this._size.x * SCALE)), h = Math.max(1, Math.floor(this._size.y * SCALE));
        if(this.rtDepth.width !== w || this.rtDepth.height !== h) for(const rt of [this.rtDepth, ...this.rtBlur]) rt.setSize(w, h);
        this.texel.value.set(1 / w, 1 / h);
        cam.updateMatrixWorld();
        this.proj.value.set(cam.projectionMatrix.elements[0], cam.projectionMatrix.elements[5]);
        const fog = this.ctx.scene.fog;
        if(fog) { this.fogColor.value.copy(fog.color); this.fogRange.value.set(fog.near, fog.far); }
        const prevRT = r.getRenderTarget(), prevAlpha = r.getClearAlpha();
        r.getClearColor(this._clear);
        r.setClearColor(0x000000, 0);
        r.setRenderTarget(this.rtDepth);
        r.clear();
        r.render(this.scene, cam);
        r.setRenderTarget(this.rtBlur[0]);
        this.blurQuad[0].render(r);
        r.setRenderTarget(this.rtBlur[1]);
        this.blurQuad[1].render(r);
        r.setRenderTarget(prevRT);
        r.setClearColor(this._clear, prevAlpha);
    }
}
