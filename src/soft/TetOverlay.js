/**
 * Debug view of the soft ground (`?tets=1` or F7): every live zone's tetrahedral lattice as lines, deformed by the
 * same vertex-stage displacement as the terrain (sim.deformNode), drawn over everything. Cyan: free nodes' edges,
 * orange: edges touching a pinned node (held by the rigid ground around the zone).
 */
import * as THREE from 'three/webgpu';
import { Fn, int } from 'three/tsl';
import { H, MAX_ZONES, TETS_EVEN, TETS_ODD, CUBE, F_PINNED } from './core.js';

export class TetOverlay {
    constructor(scene, sim) {
        this.scene = scene;
        this.visible = false;
        this.lines = new Array(MAX_ZONES).fill(null);
        const mat = this.material = new THREE.LineBasicNodeMaterial({ vertexColors: true, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false });
        mat.positionNode = Fn(() => sim.deformNode(int(0)).position)();
    }

    setVisible(v) {
        this.visible = v;
        if(!v) for(let s = 0; s < MAX_ZONES; s++) this.clear(s);
    }

    /** (Re)build slot s's lines from its zone { c0, n, lattice: { flags, cells, count } }. */
    set(s, z) {
        this.clear(s);
        if(!this.visible || !z.lattice) return;
        const { flags, cells, count } = z.lattice;
        const NX = z.n[0] + 1, NXY = NX * (z.n[1] + 1);
        const seen = new Set(), pos = [], col = [];
        const node = (i, j, k) => i + j * NX + k * NXY;
        const put = (n) => {
            const i = n % NX, j = Math.floor(n / NX) % (z.n[1] + 1), k = Math.floor(n / NXY);
            // a hair inside the lattice: the far faces' nodes are outside the trilinear lookup otherwise
            pos.push((z.c0[0] + Math.min(i, z.n[0] - 1e-3)) * H, (z.c0[1] + Math.min(j, z.n[1] - 1e-3)) * H, (z.c0[2] + Math.min(k, z.n[2] - 1e-3)) * H);
        };
        for(let c = 0; c < count; c++) {
            const v = cells[c], ci = v & 255, cj = (v >> 8) & 255, ck = (v >> 16) & 255;
            const tets = (ci + cj + ck) & 1 ? TETS_ODD : TETS_EVEN;
            for(const t of tets) for(let a = 0; a < 4; a++) for(let b = a + 1; b < 4; b++) {
                const A = CUBE[t[a]], B = CUBE[t[b]];
                let na = node(ci + A[0], cj + A[1], ck + A[2]), nb = node(ci + B[0], cj + B[1], ck + B[2]);
                if(na > nb) [na, nb] = [nb, na];
                const key = na * 8388608 + nb;
                if(seen.has(key)) continue;
                seen.add(key);
                put(na); put(nb);
                const pinned = (flags[na] & F_PINNED) || (flags[nb] & F_PINNED);
                for(let q = 0; q < 2; q++) col.push(pinned ? 1 : 0.2, pinned ? 0.55 : 0.95, pinned ? 0.15 : 1);
            }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).fill(0).map((_, i) => i % 3 === 1 ? 1 : 0), 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        const l = new THREE.LineSegments(g, this.material);
        l.frustumCulled = false;
        l.renderOrder = 10;
        this.scene.add(l);
        this.lines[s] = l;
    }

    clear(s) {
        const l = this.lines[s];
        if(!l) return;
        this.scene.remove(l);
        l.geometry.dispose();
        this.lines[s] = null;
    }
}
