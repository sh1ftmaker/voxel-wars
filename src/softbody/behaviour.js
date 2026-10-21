/**
 * How each terrain material breaks when it is debris (the fracture modes of the materials plan, after tetrafract):
 *
 *   splinter  wood: bends, cracks run along the grain (faces across the fibres are 3.75x tougher, along them 0.35x),
 *             so it comes apart in long thin pieces; crumbs become splinter particles
 *   shatter   stone, brick, cobble: stiff and brittle; over its break threshold it bursts at once into angular
 *             Voronoi pieces sized by `piece`, finest near the hit; crumbs become chips and dust
 *   glass     shatters on almost any hit into slivers: mostly particles, a few small bodies; no wobble
 *   bend      metal: past `yieldStrain` its lattice's rest shape creeps (`plastic`), the bend is baked into its voxels
 *             when it rests; it only tears at extreme strain and never bursts
 *   crumble   dirt, grass, sand, snow: no lattice; a hard landing breaks the lump into a few clods (sand and snow
 *             mostly into particles) and leaves a small mound
 *   none      bedrock
 *
 * Reads the schema fields of src/voxel/materials.js (fracture, toughness, spread, grain, yieldStrain, plastic,
 * piece [min, max] m, particle) when a material defines `fracture`; until then (and for any field it leaves out)
 * the defaults below. Pure (no DOM): used by the soft debris worker too.
 *
 *   behaviour(id) -> { mode, toughness, spread, grain (0 | 1 | 2 | -1), yieldStrain, plastic, piece, particle }
 *   latticeTough(b) -> face strain threshold of the debris lattice (toughness is in tetrafract's units)
 */
import * as Mats from '../voxel/materials.js';

const MATERIALS = Mats.MATERIALS;

/** Defaults per mode (toughness in tetrafract's units; piece: piece size range in metres, finest for hard hits). */
const MODE = {
    splinter: { toughness: 0.09, spread: 0.5, yieldStrain: 9, plastic: 0, piece: [0.25, 1.6], particle: 'splinter' },
    shatter:  { toughness: 0.05, spread: 0.6, yieldStrain: 9, plastic: 0, piece: [0.45, 1.3], particle: 'chip' },
    glass:    { toughness: 0.025, spread: 0.7, yieldStrain: 9, plastic: 0, piece: [0.12, 0.4], particle: 'glint' },
    bend:     { toughness: 0.9, spread: 0.2, yieldStrain: 0.03, plastic: 0.5, piece: [0.6, 3], particle: 'spark' },
    crumble:  { toughness: 0.08, spread: 0.6, yieldStrain: 9, plastic: 0, piece: [0.35, 0.9], particle: 'clod' },
    none:     { toughness: 1e9, spread: 0, yieldStrain: 9, plastic: 0, piece: [1, 1], particle: 'dust' },
};
/** Default mode and overrides per material id (ids of materials.js; 14, 15: wood grain y, z; 16: glass). */
const BY_ID = {
    0: ['shatter'], 8: ['shatter'], 9: ['shatter'],
    5: ['shatter', { toughness: 0.045, piece: [0.35, 1.0] }],                 // brick: mortar joints
    11: ['shatter', { piece: [0.3, 0.8] }],                                   // cobble: rounded small pieces
    12: ['shatter', { toughness: 0.6, spread: 0.3, piece: [0.9, 2.2] }],      // dark rock: few big pieces
    6: ['bend'],
    7: ['crumble', { particle: 'puff' }],                                     // lava
    10: ['splinter'], 14: ['splinter'], 15: ['splinter'],
    16: ['glass'],
    1: ['crumble'], 2: ['crumble'],
    3: ['crumble', { toughness: 0.05, piece: [0.45, 0.6], particle: 'puff' }], // sand: barely holds together
    4: ['crumble', { toughness: 0.04, piece: [0.45, 0.6], particle: 'puff' }], // snow
    13: ['none'],
};
const DEFAULT_GRAIN = { 10: 0, 14: 1, 15: 2 };
/** Lattice strain (|F - R|, src/softbody/lattice.js) per unit of tetrafract toughness; bend: the threshold is the
 *  tear strain itself (rarely reached: the lattice clamps its displacement). */
const TOUGH_SCALE = { splinter: 6, shatter: 6, glass: 6, bend: 1, crumble: 6, none: 1 };

const cache = [];
export function behaviour(id) {
    let b = cache[id];
    if(b) return b;
    const m = MATERIALS[id] || {};
    const [defMode, over] = BY_ID[id] || ['crumble'];
    const schema = m.fracture != null; // materials.js has the fracture schema (else its toughness is the ground's)
    const mode = schema ? m.fracture : defMode;
    const base = { ...MODE[mode] || MODE.crumble, ...(mode === defMode ? over : null) };
    const pick = (k) => schema && m[k] != null ? m[k] : base[k];
    const grain = typeof Mats.grainAxis === 'function' ? Mats.grainAxis(id) : (m.grain ?? DEFAULT_GRAIN[id] ?? -1);
    b = cache[id] = {
        mode, toughness: pick('toughness'), spread: pick('spread'), grain: grain ?? -1,
        yieldStrain: pick('yieldStrain'), plastic: pick('plastic'), piece: pick('piece'), particle: pick('particle'),
    };
    return b;
}
export const latticeTough = (b) => b.toughness * (TOUGH_SCALE[b.mode] ?? 6);
/** Is `id` wood (any grain)? */
export const isWoodId = (id) => typeof Mats.isWood === 'function' ? Mats.isWood(id) : behaviour(id).mode === 'splinter';

const VOXEL3 = 0.25 ** 3;
/**
 * Pieces for a Voronoi break: { n, minCount (samples: smaller pieces become particles / dust), aniso (per axis
 * Voronoi weights: wood's cells stretched along the grain), mode }. b: behaviour(mat); energy: hit / break threshold;
 * crowd: 0.35..1 (fewer pieces near the body cap); debrisMin: the smallest body (samples); few: a fixed count.
 */
export function pieceCount(b, { volume, count, energy = 1, crowd = 1, debrisMin = 16, few = 0 }) {
    let n, minCount = debrisMin, aniso = null;
    const bySize = (size) => Math.max(2, Math.min(14, Math.round(volume / (size * size * size) * crowd)));
    const t = Math.max(0, Math.min(1, (energy - 1) / 3)); // harder hits: finer pieces
    if(b.mode === 'shatter' || b.mode === 'splinter') n = bySize(b.piece[1] + (b.piece[0] - b.piece[1]) * t);
    else if(b.mode === 'glass') {
        n = Math.max(6, Math.min(20, Math.round(volume / 0.03)));
        minCount = Math.max(minCount, Math.round(count / 12)); // slivers: mostly particles, a few bodies
    } else if(b.mode === 'crumble') {
        const puff = b.particle === 'puff'; // sand, snow: falls apart
        n = puff ? 8 : Math.max(3, Math.min(8, Math.round((3 + energy * 1.5) * crowd)));
        minCount = Math.max(minCount, puff ? Math.round(count / 3) : Math.round(b.piece[0] ** 3 / VOXEL3));
    } else n = Math.max(2, Math.min(14, Math.round((1 + energy * 2 + Math.log2(1 + volume)) * crowd)));
    if(few) n = few;
    if(b.mode === 'splinter') { aniso = [1, 1, 1]; aniso[b.grain >= 0 ? b.grain : 0] = 0.06; } // long along the grain
    return { n, minCount, aniso, mode: b.mode };
}
