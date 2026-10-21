/** Terrain material table, indexed by the material id stored per voxel (ids match the Fort War level, src/level/fortwar.js).
 *
 *  hardness: how hard it is to carve; carving brushes reach 1/sqrt(hardness) as far into it as into dirt.
 *  density: kg/m³, for detached chunks. smooth: render with smooth normals (built stone gets crisper shading).
 *  texture/scale: triplanar texture (assets/textures), metres per tile. dust: colour of debris and dust. */
const T = 'assets/textures/';
export const MATERIALS = [];
function def(id, m) { MATERIALS[id] = { ...m, id }; }
def(0,  { name: 'Stone',      color: 0x8a8a8a, texture: T + 'cliff_side.jpg',             scale: 6, hardness: 3,   density: 2400, smooth: false });
def(1,  { name: 'Dirt',       color: 0x6b4a2b, texture: T + 'brown_mud_dry.jpg',          scale: 4, hardness: 1,   density: 1600, smooth: true });
def(2,  { name: 'Grass',      color: 0x4a8f3a, texture: T + 'leafy_grass.jpg',            scale: 4, hardness: 1,   density: 1600, smooth: true });
def(3,  { name: 'Sand',       color: 0xd8c27a, texture: T + 'coast_sand_01.jpg',          scale: 4, hardness: 0.7, density: 1700, smooth: true });
def(4,  { name: 'Snow',       color: 0xeef2f5, texture: T + 'snow_02.jpg',                scale: 4, hardness: 0.5, density: 500,  smooth: true });
def(5,  { name: 'Brick',      color: 0x9b3f2f, texture: T + 'brick_wall_02.jpg',          scale: 3, hardness: 3,   density: 2000, smooth: false });
def(6,  { name: 'Metal',      color: 0x6c7a89, texture: T + 'metal_plate.jpg',            scale: 2, hardness: 6,   density: 7800, smooth: false });
def(7,  { name: 'Lava',       color: 0xff5a1f, texture: null,                             scale: 4, hardness: 1,   density: 3000, smooth: true });
def(8,  { name: 'Red Stone',  color: 0xc98b7e, texture: T + 'large_sandstone_blocks.jpg', scale: 4, hardness: 3,   density: 2300, smooth: false });
def(9,  { name: 'Blue Stone', color: 0x8ea2c4, texture: T + 'large_sandstone_blocks.jpg', scale: 4, hardness: 3,   density: 2300, smooth: false });
def(10, { name: 'Wood',       color: 0x8b5a2b, texture: T + 'weathered_brown_planks.jpg', scale: 3, hardness: 1.5, density: 700,  smooth: false });
def(11, { name: 'Cobble',     color: 0x7d7d78, texture: T + 'cobblestone_floor_08.jpg',   scale: 3, hardness: 2,   density: 2300, smooth: false });
def(12, { name: 'Dark Rock',  color: 0x5a5550, texture: T + 'dark_rock.jpg',              scale: 6, hardness: 5,   density: 2600, smooth: true });
def(13, { name: 'Bedrock',    color: 0x2a2826, texture: T + 'dark_rock.jpg',              scale: 6, hardness: Infinity, density: 3000, smooth: true });
// wood is stored with its grain axis: 10 along X, 14 along Y, 15 along Z (same look and behaviour otherwise)
def(14, { ...MATERIALS[10], name: 'Wood (Y)' });
def(15, { ...MATERIALS[10], name: 'Wood (Z)' });
def(16, { name: 'Glass',      color: 0xa9d4e0, texture: null,                             scale: 4, hardness: 0.4, density: 2500, smooth: false });
export const BEDROCK = 13;
export const WOOD = 10, WOOD_Y = 14, WOOD_Z = 15, GLASS = 16;
/** Material ids are stored in a Uint8 per sample; tables indexed by id (shaders, soft ground) have MAT_SLOTS entries. */
export const MAT_SLOTS = 32;
for(let i = 0; i < MATERIALS.length; i++) if(!MATERIALS[i]) def(i, { ...MATERIALS[1], name: `unused ${i}` });

/** Carving reach multiplier per material id (1/sqrt(hardness)), as a typed array for hot loops. */
export const REACH = new Float32Array(256).fill(1);
for(const m of MATERIALS) REACH[m.id] = m.hardness === Infinity ? 0 : 1 / Math.sqrt(m.hardness);

/** Soft ground (src/soft): how a material responds when an impact wakes it into a simulated zone.
 *  stiffness  0..1 shape-matching pull toward the rest shape per solver iteration (low = jelly, slow wobble; with
 *             the default 4 iterations x 240 Hz substeps, 0.05 wobbles at ~3 Hz, 0.3 is a stiff ~10 Hz buzz)
 *  softness   gain on the velocity an impact injects (high = deforms further)
 *  plasticity 0..1 how fast the rest shape follows a deformation past `yield` metres (per 1/60 s; 0 = elastic,
 *             springs back; > 0 keeps the dent / mound, which is baked into the SDF when the zone settles)
 *  toughness  strain at which the material would tear (reserved for tearing)
 *  damping    1/s velocity loss while wobbling */
const SOFT = {
    0:  { stiffness: 0.09,  softness: 1.7, plasticity: 0,    yield: 0.02, toughness: 0.10, damping: 1.3 }, // stone
    1:  { stiffness: 0.045, softness: 1.5,  plasticity: 0.05, yield: 0.04, toughness: 0.05, damping: 1.8 }, // dirt
    2:  { stiffness: 0.045, softness: 1.5,  plasticity: 0.05, yield: 0.04, toughness: 0.05, damping: 1.8 }, // grass
    3:  { stiffness: 0.03, softness: 1.6, plasticity: 0.08, yield: 0.03, toughness: 0.03, damping: 2.4 }, // sand
    4:  { stiffness: 0.025, softness: 1.7, plasticity: 0.12, yield: 0.03, toughness: 0.02, damping: 2.8 },   // snow
    5:  { stiffness: 0.08,  softness: 1.7,  plasticity: 0,    yield: 0.02, toughness: 0.08, damping: 1.3 }, // brick
    6:  { stiffness: 0.12,  softness: 1.1, plasticity: 0,    yield: 0.02, toughness: 0.2,  damping: 0.9 }, // metal
    7:  { stiffness: 0.02, softness: 1.0,  plasticity: 0,    yield: 0.02, toughness: 0.02, damping: 3 },   // lava
    8:  { stiffness: 0.09,  softness: 1.7, plasticity: 0,    yield: 0.02, toughness: 0.10, damping: 1.3 }, // red stone
    9:  { stiffness: 0.09,  softness: 1.7, plasticity: 0,    yield: 0.02, toughness: 0.10, damping: 1.3 }, // blue stone
    10: { stiffness: 0.05, softness: 1.6,  plasticity: 0,    yield: 0.02, toughness: 0.08, damping: 1.1 },   // wood
    11: { stiffness: 0.08, softness: 1.6, plasticity: 0,    yield: 0.02, toughness: 0.08, damping: 1.5 },   // cobble
    12: { stiffness: 0.1,  softness: 1.4, plasticity: 0,    yield: 0.02, toughness: 0.14, damping: 1.3 }, // dark rock
    13: { stiffness: 1.0,  softness: 0,    plasticity: 0,    yield: 1,    toughness: 1e9,  damping: 10 },  // bedrock
    16: { stiffness: 0.12, softness: 0.9,  plasticity: 0,    yield: 0.02, toughness: 0.03, damping: 2.0 }, // glass: stiff, rings
};
SOFT[14] = SOFT[15] = SOFT[10];
// metal dents and stays dented (the soft ground bakes plastic zones into the SDF)
SOFT[6] = { ...SOFT[6], plasticity: 0.12, yield: 0.025 };
for(const m of MATERIALS) {
    const s = SOFT[m.id] || SOFT[1];
    // `toughness` there is the soft ground's (tearing); the fracture table below owns `toughness`
    const { toughness, ...rest } = s;
    Object.assign(m, rest, { softToughness: toughness });
}

/**
 * Fracture behaviour (the materials plan; values start from tetrafract's builder.js MATERIALS):
 *   fracture     'splinter' (wood: bends, cracks run along the grain into long splinters) | 'shatter' (stone: stiff,
 *                brittle, chunky angular pieces + chips + dust) | 'bend' (metal: plastic, the bend becomes permanent,
 *                tears only at extreme strain) | 'crumble' (dirt, sand, snow: no rigid shards; lumps fall apart into
 *                clods and a mound) | 'glass' (instant shatter into slivers) | 'none' (bedrock)
 *   toughness    face strain to break (tetrafract units: tet goal mismatch over tet size)
 *   spread       0..1 random variation of the threshold per face (irregular cracks)
 *   grain        fibre axis (0 x, 1 y, 2 z) or -1; a face cut across the fibres is up to 3.75x tougher, one along
 *                them 0.35x (tetrafract: thr *= 0.35 + 3.4 * along²)
 *   yieldStrain  strain past which deformation becomes permanent (9 = never)
 *   plastic      rest-shape creep rate past yield (0 = elastic)
 *   stiffnessMode 'rigid' (cracks within a frame or two, little bending) | 'flex' (bends visibly first) | 'plastic'
 *                | 'loose' (barely holds together)
 *   piece        [min, max] target fragment size in metres
 *   particle     cosmetic debris: 'splinter' | 'chip' | 'spark' | 'clod' | 'puff' | 'glint' | 'dust'
 *   sound        'wood' | 'stone' | 'metal' | 'dirt' | 'glass' | 'snow'
 *   fresh        colour of a fresh break (the fresh-break tint), multiplier on the albedo
 */
const FRACTURE = {
    stone:  { fracture: 'shatter',  toughness: 0.05,  spread: 0.6,  grain: -1, yieldStrain: 9,     plastic: 0,    stiffnessMode: 'rigid',   piece: [0.3, 1.2], particle: 'chip',     sound: 'stone', fresh: [1.35, 1.32, 1.28] },
    brick:  { fracture: 'shatter',  toughness: 0.045, spread: 0.5,  grain: -1, yieldStrain: 9,     plastic: 0,    stiffnessMode: 'rigid',   piece: [0.25, 1.0], particle: 'chip',    sound: 'stone', fresh: [1.3, 1.15, 1.05] },
    cobble: { fracture: 'shatter',  toughness: 0.05,  spread: 0.7,  grain: -1, yieldStrain: 9,     plastic: 0,    stiffnessMode: 'rigid',   piece: [0.25, 0.8], particle: 'chip',    sound: 'stone', fresh: [1.3, 1.3, 1.25] },
    rock:   { fracture: 'shatter',  toughness: 0.2,   spread: 0.3,  grain: -1, yieldStrain: 9,     plastic: 0,    stiffnessMode: 'rigid',   piece: [0.8, 2.5], particle: 'chip',     sound: 'stone', fresh: [1.4, 1.35, 1.3] },
    wood:   { fracture: 'splinter', toughness: 0.09,  spread: 0.5,  grain: 0,  yieldStrain: 0.06,  plastic: 0.05, stiffnessMode: 'flex',    piece: [0.2, 2.5], particle: 'splinter', sound: 'wood',  fresh: [1.45, 1.25, 1.0] },
    metal:  { fracture: 'bend',     toughness: 0.9,   spread: 0.2,  grain: -1, yieldStrain: 0.012, plastic: 0.5,  stiffnessMode: 'plastic', piece: [0.5, 3.0], particle: 'spark',    sound: 'metal', fresh: [1.7, 1.7, 1.75] },
    dirt:   { fracture: 'crumble',  toughness: 0.03,  spread: 0.6,  grain: -1, yieldStrain: 0.04,  plastic: 0.1,  stiffnessMode: 'loose',   piece: [0.2, 0.6], particle: 'clod',     sound: 'dirt',  fresh: [0.78, 0.74, 0.7] },
    sand:   { fracture: 'crumble',  toughness: 0.015, spread: 0.5,  grain: -1, yieldStrain: 0.03,  plastic: 0.15, stiffnessMode: 'loose',   piece: [0.15, 0.4], particle: 'puff',    sound: 'dirt',  fresh: [0.85, 0.82, 0.78] },
    snow:   { fracture: 'crumble',  toughness: 0.01,  spread: 0.5,  grain: -1, yieldStrain: 0.03,  plastic: 0.2,  stiffnessMode: 'loose',   piece: [0.15, 0.4], particle: 'puff',    sound: 'snow',  fresh: [1.05, 1.05, 1.08] },
    glass:  { fracture: 'glass',    toughness: 0.025, spread: 0.7,  grain: -1, yieldStrain: 9,     plastic: 0,    stiffnessMode: 'rigid',   piece: [0.05, 0.5], particle: 'glint',   sound: 'glass', fresh: [1, 1, 1] },
    lava:   { fracture: 'crumble',  toughness: 0.4,   spread: 0.3,  grain: -1, yieldStrain: 9,     plastic: 0,    stiffnessMode: 'loose',   piece: [0.3, 1.0], particle: 'spark',    sound: 'stone', fresh: [1.2, 1.1, 1.0] },
    none:   { fracture: 'none',     toughness: 1e9,   spread: 0,    grain: -1, yieldStrain: 9,     plastic: 0,    stiffnessMode: 'rigid',   piece: [1, 1],     particle: 'dust',     sound: 'stone', fresh: [1, 1, 1] },
};
const FRACTURE_OF = { 0: 'stone', 1: 'dirt', 2: 'dirt', 3: 'sand', 4: 'snow', 5: 'brick', 6: 'metal', 7: 'lava', 8: 'stone', 9: 'stone',
    10: 'wood', 11: 'cobble', 12: 'rock', 13: 'none', 14: 'wood', 15: 'wood', 16: 'glass' };
for(const m of MATERIALS) Object.assign(m, FRACTURE[FRACTURE_OF[m.id] || 'dirt'], { piece: [...FRACTURE[FRACTURE_OF[m.id] || 'dirt'].piece] });
MATERIALS[14].grain = 1; MATERIALS[15].grain = 2;

/** Grain axis of a material id (0 x, 1 y, 2 z), -1 for materials without grain. */
export const grainAxis = (id) => MATERIALS[id]?.grain ?? -1;
/** True for any of the wood ids (10, 14, 15). */
export const isWood = (id) => id === WOOD || id === WOOD_Y || id === WOOD_Z;
/** The wood id whose grain runs along `axis` (0 x, 1 y, 2 z). */
export const woodWithGrain = (axis) => axis === 1 ? WOOD_Y : axis === 2 ? WOOD_Z : WOOD;
