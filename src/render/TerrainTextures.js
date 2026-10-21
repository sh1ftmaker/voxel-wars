/** The terrain's texture array: one layer per distinct texture in the material table (src/voxel/materials.js) plus
 *  one flat grey layer for untextured materials, and per material id a uniform table the shader indexes:
 *  `tints` (linear RGB multiplier) and `props` (layer, tiles per metre, glow, 0).
 *
 *  Before the images arrive the array is a tiny white placeholder and each tint is the material's flat colour, so the
 *  world shows its palette immediately. When a texture is shared by several materials (red and blue stone) or a material
 *  has none, its tint maps the layer's mean colour onto the material colour; otherwise the tint is white. One shared
 *  instance (`terrainTextures()`), so every terrain and body material samples the same GPU texture. */
import * as THREE from 'three/webgpu';
import { MATERIALS } from '../voxel/materials.js';
import { isMobile } from './device.js';

const FLAT = 0.55; // the flat layer's grey (sRGB 0..1)
/** How far a texture used by one material is pulled towards the material's palette hue (0 = the texture as is):
 *  the grass photo is a dry yellow-green, and the cliff photo is orange where the palette wants grey stone. */
const HUE_TINT = { Grass: 0.6, Stone: 0.6, Dirt: 0.25 };

class TerrainTextures {
    constructor() {
        this.size = isMobile ? 512 : 1024;
        this.paths = [...new Set(MATERIALS.filter(m => m.texture).map(m => m.texture))];
        this.flatLayer = this.paths.length;
        this.depth = this.paths.length + 1;
        const ph = new Uint8Array(4 * 4 * 4 * this.depth).fill(255);
        this.texture = new THREE.DataArrayTexture(ph, 4, 4, this.depth);
        this.texture.colorSpace = THREE.SRGBColorSpace;
        this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;
        this.texture.minFilter = THREE.LinearMipmapLinearFilter;
        this.texture.magFilter = THREE.LinearFilter;
        this.texture.generateMipmaps = true;
        this.texture.anisotropy = isMobile ? 2 : 8;
        this.texture.needsUpdate = true;
        this.count = Math.max(16, MATERIALS.length);
        this.tints = [];
        this.props = [];
        for(let i = 0; i < this.count; i++) {
            const m = MATERIALS[i] || MATERIALS[1];
            this.tints.push(new THREE.Color(m.color));
            const layer = m.texture ? this.paths.indexOf(m.texture) : this.flatLayer;
            this.props.push(new THREE.Vector4(layer, 1 / (m.scale || 4), m.name === 'Lava' ? 1 : 0, 0));
        }
        this.ready = this._load().catch(e => console.warn('terrain textures:', e.message));
    }
    async _load() {
        const S = this.size, L = S * S * 4;
        const data = new Uint8Array(L * this.depth);
        const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        const means = [];
        await Promise.all(this.paths.map(async (path, i) => {
            const base = i * L;
            try {
                const blob = await (await fetch(new URL(path, document.baseURI))).blob();
                const bmp = await createImageBitmap(blob, { resizeWidth: S, resizeHeight: S, resizeQuality: 'high' });
                const canvas = new OffscreenCanvas(S, S), c2 = canvas.getContext('2d');
                c2.drawImage(bmp, 0, 0);
                bmp.close?.();
                data.set(c2.getImageData(0, 0, S, S).data, base);
            } catch(e) {
                console.warn(`terrain texture ${path} failed: ${e.message}`);
                data.fill(255, base, base + L);
            }
            const sum = [0, 0, 0]; let n = 0;
            for(let p = base; p < base + L; p += 4 * 13) { sum[0] += lin(data[p]); sum[1] += lin(data[p + 1]); sum[2] += lin(data[p + 2]); n++; }
            means[i] = sum.map(v => v / n);
        }));
        const flat = Math.round(FLAT * 255);
        data.fill(flat, this.flatLayer * L, this.flatLayer * L + L);
        means[this.flatLayer] = [lin(flat), lin(flat), lin(flat)];
        // the GPU texture was created at the placeholder's size: dispose so the backend recreates it
        this.texture.dispose();
        this.texture.image = { data, width: S, height: S, depth: this.depth };
        this.texture.needsUpdate = true;
        const users = new Map();
        for(const m of MATERIALS) if(m.texture) users.set(m.texture, (users.get(m.texture) || 0) + 1);
        for(let i = 0; i < this.count; i++) {
            const m = MATERIALS[i] || MATERIALS[1];
            const layer = this.props[i].x;
            const amount = m.texture && users.get(m.texture) === 1 ? (HUE_TINT[m.name] || 0) : 1;
            if(amount === 0) { this.tints[i].setRGB(1, 1, 1); continue; }
            // the material's hue at the geometric mean of its own and the texture's brightness
            const c = new THREE.Color(m.color), mean = means[layer];
            const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
            const k = Math.sqrt(lum(...mean) / Math.max(1e-4, lum(c.r, c.g, c.b)));
            const t = (v, mv) => 1 + (Math.min(4, k * v / mv) - 1) * amount;
            this.tints[i].setRGB(t(c.r, mean[0]), t(c.g, mean[1]), t(c.b, mean[2]));
        }
        this.loaded = true;
    }
}

let shared = null;
/** The shared TerrainTextures instance (created on first use). */
export function terrainTextures() { return shared ||= new TerrainTextures(); }
