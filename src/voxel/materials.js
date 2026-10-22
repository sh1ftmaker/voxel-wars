/** Terrain material table, indexed by the material id stored per voxel (ids match the Fort War level, src/level/fortwar.js).
 *
 *  hardness: how hard it is to carve; carving brushes reach 1/sqrt(hardness) as far into it as into dirt.
 *  density: kg/m³, for detached chunks. smooth: render with smooth normals (built stone gets crisper shading).
 *  texture/scale: triplanar texture (assets/textures), metres per tile. dust: colour of debris and dust. */
const T = 'assets/textures/';
export const MATERIALS = [];
function def(id, m) { MATERIALS[id] = { id, ...m }; }
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
def(16, { name: 'Glass',      color: 0xa9d4e0, texture: null,                             scale: 4, hardness: 0.4, density: 2500, smooth: false });
export const BEDROCK = 13;
export const GLASS = 16;
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
    16: { stiffness: 0.12, softness: 0.9,  plasticity: 0,    yield: 0.02, toughness: 0.03, damping: 2.0 }, // glass
    13: { stiffness: 1.0,  softness: 0,    plasticity: 0,    yield: 1,    toughness: 1e9,  damping: 10 },  // bedrock
};
for(const m of MATERIALS) Object.assign(m, SOFT[m.id] || SOFT[1]);
