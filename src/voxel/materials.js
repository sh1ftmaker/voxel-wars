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
export const BEDROCK = 13;
for(let i = 0; i < MATERIALS.length; i++) if(!MATERIALS[i]) def(i, { ...MATERIALS[1], name: `unused ${i}` });

/** Carving reach multiplier per material id (1/sqrt(hardness)), as a typed array for hot loops. */
export const REACH = new Float32Array(256).fill(1);
for(const m of MATERIALS) REACH[m.id] = m.hardness === Infinity ? 0 : 1 / Math.sqrt(m.hardness);
