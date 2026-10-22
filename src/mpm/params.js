/**
 * Granular ground (PB-MPM): shared constants and the per-material table. Used by the GPU solver (MpmGPU.js), the CPU
 * solver (cpuSolver.js, also in Node tests), the terrain worker's grain selection (grains.js) and the system (Mpm.js).
 *
 * Units: the solver works in grid units (one cell = H metres = one voxel), so a zone's nodes sit exactly on the voxel
 * lattice: node (i, j, k) of a zone whose lattice origin is `lo` is sample lo + (i, j, k).
 */
import { VOXEL } from '../config.js';

export const H = VOXEL;                 // m per grid cell (= the voxel lattice)
export const ZONE_DIMS = [48, 32, 48];  // nodes per zone (12 x 8 x 12 m)
export const MAX_ZONES = 4;             // zone slots
export const PER_ZONE = 16384;          // particle slots per zone (GPU); 4 x 16k = 64k particles at most
export const CPU_CAP = 6144;            // particles in all on the CPU fallback
export const GUARD = 2;                 // nodes along a zone's walls that act as a wall
export const GRAVITY = 30;              // m/s² (the game's gravity, src/physics/Physics.js)
export const FIXED = 1 << 20;           // fixed-point scale of the P2G atomics (grid momentum x mass): range ±2048
export const MAX_PROXIES = 8;           // body / player spheres per frame (one-way coupling)

/** Material models. */
export const SAND = 0, SNOW = 1, VISCO = 2;

/**
 * Per terrain material id (src/voxel/materials.js): the model and its parameters, or nothing (not granular: stone,
 * brick, metal, wood... never turn into particles).
 *   model     SAND (Drucker-Prager, Klár et al. 2016), SNOW (corotated elastic + Stomakhin et al. 2013 plasticity),
 *             VISCO (volume-preserving viscoplastic paste: lava, mud)
 *   friction  internal friction angle (deg, sand); also the angle of repose used to pick unstable voxels
 *   cohesion  log-volume a sand particle may stretch before it stops resisting (0 = dry sand; dirt holds clods)
 *   relax     relaxation of the PB-MPM constraint per iteration (the stiffness knob: 0..~1.5)
 *   visc      viscosity relaxation: pulls the deformation rate's symmetric part to 0 per iteration
 *   alpha     elastic target blend: 1 = rotation only (shape), 0 = volume only (F / det^(1/3))
 *   thetaC/S  snow: critical compression / stretch (Stomakhin)    xi: hardening    yield: visco stretch limit
 *   wall      Coulomb friction against the terrain and the zone walls
 *   density   relative particle mass (kg/m³ / 1000)
 *   minStretch  the smallest stretch F keeps (the reference's safety clamp is 0.1); sand forgets compression past
 *             it (a hard landing compacts instead of storing a rebound)
 *   flow      free-flowing (sand, snow): any carve (a dig too) releases what is steeper than its angle of repose or
 *             undercut, and the failure runs up the slope. Cohesive ground (dirt, grass, lava; flow false) only lets
 *             go of a blast's lip and the steepest of what that exposes: tunnels and dug walls in dirt hold
 */
export const GRANULAR = {
    3: { model: SAND, friction: 33, cohesion: 0,     relax: 0.9, visc: 0.02, alpha: 1,    wall: 0.6, density: 1.7, minStretch: 0.8, flow: true }, // sand
    1: { model: SAND, friction: 40, cohesion: 0.01,  relax: 0.9, visc: 0.04, alpha: 1,    wall: 0.8, density: 1.6, minStretch: 0.8 }, // dirt
    2: { model: SAND, friction: 40, cohesion: 0.01,  relax: 0.9, visc: 0.04, alpha: 1,    wall: 0.8, density: 1.6, minStretch: 0.8 }, // grass (its dirt)
    4: { model: SNOW, friction: 38, relax: 0.8, visc: 0.02, alpha: 0.9, thetaC: 0.025, thetaS: 0.0075, xi: 10, wall: 0.7, density: 0.5, flow: true }, // snow
    7: { model: VISCO, friction: 20, relax: 0.6, visc: 0.15, alpha: 0.5, yield: 0.06, wall: 0.4, density: 3.0 }, // lava
};
export const isGranular = (m) => GRANULAR[m] !== undefined;
export const isFlowing = (m) => !!GRANULAR[m]?.flow;

/** Per-material parameters as a flat table: 4 vec4 per material id (0..15), for the GPU and the CPU solver.
 *  row 0: (model, alphaDP (Drucker-Prager cone), cohesion, relax)
 *  row 1: (visc, alpha, thetaC, thetaS)
 *  row 2: (xi, yield (log), wall friction, density)
 *  row 3: (granular 0/1, minStretch, -, -) */
export const MAT_ROWS = 4;
export function materialTable() {
    const t = new Float32Array(16 * MAT_ROWS * 4);
    for(let m = 0; m < 16; m++) {
        const g = GRANULAR[m] || GRANULAR[3];
        const s = Math.sin(g.friction * Math.PI / 180);
        const alphaDP = Math.sqrt(2 / 3) * 2 * s / (3 - s);
        const o = m * MAT_ROWS * 4;
        t.set([g.model, alphaDP, g.cohesion || 0, g.relax], o);
        t.set([g.visc, g.alpha, g.thetaC || 0, g.thetaS || 0], o + 4);
        t.set([g.xi || 0, g.yield || 0, g.wall, g.density], o + 8);
        t.set([GRANULAR[m] ? 1 : 0, g.minStretch ?? 0.1, 0, 0], o + 12);
    }
    return t;
}

/** Solver knobs (ctx.mpm.knobs, URL ?mpmIters= ?mpmSub=): see docs/MPM.md. */
export const DEFAULT_KNOBS = {
    substeps: 1,        // per 60 Hz frame (PB-MPM is stable at the full frame step)
    iterations: 3,      // PB-MPM solve iterations per substep (P2G, grid, G2P, constraint projection)
    relaxScale: 1,      // multiplies every material's relax
    restSpeed: 0.12,    // m/s: below this a particle counts as at rest
    restFrames: 20,     // substeps at rest before a particle counts as settled
    maxStep: 1,         // cells a particle may move per substep (CFL clamp)
};

/** Particle position word: pos.w packs the slot, the particles-per-voxel level and the material (-1: dead). */
export const packW = (slot, ppcLog, mat) => (slot * 4 + ppcLog) * 32 + mat;
export const unpackW = (w) => { const mat = w & 31, r = w >> 5; return { mat, ppcLog: r & 3, slot: r >> 2 }; };
