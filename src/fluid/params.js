/**
 * SPH fluid constants shared by the GPU solver (src/fluid/FluidGPU.js), the CPU solver (src/fluid/cpuSolver.js, in
 * src/workers/fluid.js and in node tests) and the renderer. See docs/SPH.md.
 *
 * The solver is Position Based Fluids (Macklin & Müller 2013): SPH density estimated with the poly6 kernel, an
 * incompressibility constraint per particle solved by Jacobi iterations with the spiky kernel's gradient, artificial
 * pressure (s_corr) against clumping, XSPH viscosity, collisions against the voxel world's signed distance field.
 * Everything is normalized so a particle's mass is 1 and the rest density is 1 (kernels divided by RHO0).
 */

/** Particle phases (pos.w). 0 = dead slot. */
export const DEAD = 0, WATER = 1, LAVA = 2;

/** Per-phase material: XSPH viscosity (fraction of the neighbourhood's relative velocity removed per substep),
 *  tangential friction against the terrain per substep, extra velocity damping (1/s), whether idle thin films
 *  evaporate (recycled). */
export const PHASES = {
    [WATER]: { xsph: 0.04, friction: 0.04, damping: 0.05, evaporate: 1 },
    [LAVA]: { xsph: 0.55, friction: 0.35, damping: 1.6, evaporate: 0 },
};

/** Solver settings per backend. spacing: rest distance between particles (m; the kernel radius h is twice that);
 *  cap: particle slots. 4 Jacobi iterations per substep are the fewest that let a 3 m deep tank come to rest (with 3 a
 *  compression wave keeps a third of it moving); one substep is enough at the CPU's coarser spacing. */
export const GPU_SETTINGS = { spacing: 0.2, cap: 32768, iterations: 4, substeps: 2 };
export const CPU_SETTINGS = { spacing: 0.3, cap: 4096, iterations: 4, substeps: 1 };

export const GRAVITY = 20;        // m/s² (bodies fall at 30, real gravity reads as slow motion at this scale)
export const MAX_SPEED = 16;      // m/s clamp
export const STEP = 1 / 60;       // s: the solver runs at a fixed 60 Hz (with `substeps` substeps)
export const S_CORR_K = 0.005;    // artificial pressure strength (Macklin: 0.1; this light keeps the surface from clumping without expanding the bulk)
export const S_CORR_DQ = 0.25;    // its reference distance as a fraction of h
export const RELAX = 0.02;        // CFM epsilon as a fraction of the rest-state sum |grad C|^2
export const IDLE_SPEED = 0.08;   // m/s: slower than this counts as idle
export const EVAPORATE_DENSITY = 0.55; // a film thinner than this (rho / rho0) evaporates after EVAPORATE_TIME idle
export const EVAPORATE_TIME = 12; // s
export const MAX_NEIGHBOURS = 64;
export const MAX_PROXIES = 16;
export const MAX_KICKS = 4;

/** Derived kernel constants for a particle spacing. */
export function kernel(spacing) {
    const h = 2 * spacing, h2 = h * h;
    const poly6 = 315 / (64 * Math.PI * h ** 9);
    const spiky = -45 / (Math.PI * h ** 6);
    const W = (r2) => r2 < h2 ? poly6 * (h2 - r2) ** 3 : 0;
    // rest density: a particle inside a cubic lattice of the spacing
    let rho0 = 0, g2 = 0;
    const gs = [0, 0, 0];
    const R = 3;
    for(let z = -R; z <= R; z++) for(let y = -R; y <= R; y++) for(let x = -R; x <= R; x++) {
        const r2 = (x * x + y * y + z * z) * spacing * spacing;
        rho0 += W(r2);
        const r = Math.sqrt(r2);
        if(r > 0 && r < h) { const g = spiky * (h - r) ** 2 / r; const v = [x * spacing * g, y * spacing * g, z * spacing * g]; g2 += v[0] ** 2 + v[1] ** 2 + v[2] ** 2; gs[0] += v[0]; gs[1] += v[1]; gs[2] += v[2]; }
    }
    // sum |grad_k C|^2 at rest (normalized by rho0): sets the CFM epsilon's scale
    const sumGrad2 = (g2 + gs[0] ** 2 + gs[1] ** 2 + gs[2] ** 2) / (rho0 * rho0);
    const dq = S_CORR_DQ * h;
    // Terrain walls count as matter in the density (no boundary particles): the wall below a particle at distance d is
    // modelled as layers of virtual particles at d + s/2 + k s, each layer a continuous plane of the lattice's areal
    // density: plane(y) = pi / (4 s^2) poly6 (h^2 - y^2)^4. `wallScale` calibrates it so a lattice resting on a wall
    // (d = s / 2) has exactly the rest density.
    let half = 0;
    for(let z = -R; z <= R; z++) for(let y = 0; y <= R; y++) for(let x = -R; x <= R; x++) half += W((x * x + y * y + z * z) * spacing * spacing);
    // |sum grad W| / rho0 of a particle at a flat free surface: scales the surface normal the renderer gets to ~1
    let surfG = 0;
    for(let z = -R; z <= R; z++) for(let y = -R; y <= 0; y++) for(let x = -R; x <= R; x++) {
        const r = Math.sqrt(x * x + y * y + z * z) * spacing;
        if(r > 0 && r < h) surfG += -y * spacing * spiky * (h - r) ** 2 / r / rho0;
    }
    const k = { spacing, h, h2, poly6, spiky, rho0, eps: RELAX * sumGrad2, wdq: W(dq * dq), radius: spacing * 0.5, wallScale: 1, surfG: Math.abs(surfG) };
    k.wallScale = (rho0 - half) / (wall(k, spacing * 0.5)[0] * rho0);
    return k;
}

/** Wall density (normalized by rho0) at distance d from the terrain, and its derivative along d: [phi, dphi/dd]. */
export function wall(k, d) {
    const { spacing: s, h, h2, poly6, rho0, wallScale } = k;
    let phi = 0, dphi = 0;
    for(let i = 0; i < 2; i++) {
        const y = d + s * 0.5 + i * s;
        if(y >= h || y <= -h) continue;
        const a = h2 - y * y;
        phi += a * a * a * a;
        dphi += -8 * y * a * a * a;
    }
    const c = Math.PI / (4 * s * s) * poly6 / rho0 * wallScale;
    return [phi * c, dphi * c];
}
