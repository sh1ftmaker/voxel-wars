/** World-wide constants shared by every module. Units are metres. */

/** Edge of one voxel (the spacing of the density lattice). */
export const VOXEL = 0.25;
/** Samples per chunk edge. A chunk owns samples [c*CHUNK, (c+1)*CHUNK) on each axis. */
export const CHUNK = 32;
export const CHUNK_M = VOXEL * CHUNK;
/** Stored signed distance units per voxel: stored = round(d / VOXEL * SDF_SCALE), clamped to Int8.
 *  Distances are therefore exact to about 1/32 voxel within ±4 voxels of the surface and saturated beyond. */
export const SDF_SCALE = 32;
export const SDF_MAX = 127;
/** Mesher padding: a chunk's mesh job sees samples [-PAD, CHUNK + PAD) around it. */
export const PAD = 2;

/** World extent in chunks: [min, max) per axis. Below min y is unbreakable bedrock; everything else outside is air. */
export const WORLD_CHUNKS = { min: [-10, -2, -5], max: [10, 2, 5] };
/** Samples this close to the bottom of the world are never carved (bedrock). */
export const BEDROCK_SAMPLES = 2;
