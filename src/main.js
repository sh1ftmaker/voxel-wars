/**
 * Entry point. Builds the shared context every subsystem receives and runs the frame loop.
 *
 *   ctx = { renderer, scene, camera, sun, world (VoxelWorld), terrain (TerrainRenderer), physics (Physics),
 *           destruction (Destruction), params, addSystem(system), events }
 * A system is any object with optional update(dt) (called every frame after physics, in the order added).
 * ctx.events is an EventTarget for cross-module game events (see docs/ARCHITECTURE.md for the event list).
 */
import * as THREE from 'three/webgpu';
import { VoxelWorld } from './voxel/VoxelWorld.js';
import { voxelize } from './voxel/voxelize.js';
import { TerrainSync } from './voxel/TerrainSync.js';
import { Level } from './level/fortwar.js';
import { TerrainRenderer } from './render/TerrainRenderer.js';
import { Environment, configureRenderer } from './render/Environment.js';
import { Physics } from './physics/Physics.js';
import { Destruction } from './physics/Destruction.js';
import { FlyCamera } from './dev/FlyCamera.js';
import { FortWar } from './game/FortWar.js';
import { Profiler } from './dev/Profiler.js';
import { SoftGround } from './soft/SoftGround.js';
import { createNet } from './net/index.js';
import { Mpm } from './mpm/Mpm.js';

const $ = (id) => document.getElementById(id);
const status = (s) => { $('loading').textContent = s; };
const nextFrame = () => new Promise(r => requestAnimationFrame(r));
const params = new URLSearchParams(location.search);

const renderer = new THREE.WebGPURenderer({ antialias: true, trackTimestamp: params.has('profile') }); // GPU timings for ?profile
await renderer.init();
configureRenderer(renderer); // pixel ratio per device, ACES, shadows (src/render/Environment.js)
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);
const prof = new Profiler({ renderer, params, ctx: {} }); // ?profile or F9: record frame timings to a file (src/dev/Profiler.js)
prof.loadMark('renderer');

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 500);
camera.position.set(-70, 14, 0);
const env = new Environment({ scene, camera, renderer }); // sky, fog, hemisphere + sun with camera-following shadows
const sun = env.sun;
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

status('Building the world...');
await nextFrame();
const world = new VoxelWorld();
let t0 = performance.now();
// the terrain worker (src/voxel/TerrainSync.js) owns the world and its edits; `world` here is its read-only replica
// (?terrainWorker=0: the same core runs on the main thread)
let sync = null;
if(params.get('terrainWorker') === 'sync') voxelize(world, new Level()); // no worker at all: edits on the main thread
else await (sync = new TerrainSync(world, { worker: params.get('terrainWorker') !== '0' })).init();
// the edit log (src/net): every terrain edit is sequenced and applied in order (single player: synchronously)
if(params.get('room')) status(`Joining room "${params.get('room')}"...`);
let net = null;
try { net = sync ? await createNet(params, sync) : null; }
catch(e) { status(`Could not reach the room server (${e.message}). Reload to try again, or play offline without ?room= in the address.`); throw e; }
console.log(`world ready in ${(performance.now() - t0).toFixed(0)} ms`);
prof.loadMark('world');
const terrain = new TerrainRenderer(world, scene, camera);
status('Starting physics...');
const physics = await Physics.create({ world, terrain, scene });
terrain.remeshAll();

const systems = [];
const ctx = { renderer, scene, camera, sun, env, world, terrain, physics, params, net, events: new EventTarget(), addSystem: (s, name) => { s.profileName = name || s.constructor.name; systems.push(s); return s; } };
prof.ctx = ctx;
ctx.destruction = new Destruction(ctx);
window.ctx = ctx; // for debugging and headless tests

// ---- game systems are added here (one line each) ----
ctx.addSystem(params.get('fly') === '1' ? new FlyCamera(ctx) : new FortWar(ctx), 'game');
ctx.addSystem(new SoftGround(ctx), 'soft'); // soft ground wake zones (src/soft), ctx.soft
ctx.addSystem(new Mpm(ctx), 'mpm'); // granular ground: PB-MPM sand, dirt, snow, lava (src/mpm, ?mpm=1), ctx.mpm
net?.ready(); // the edit handlers are in: apply the log (a late joiner catches up here)

status('Meshing...');
while(terrain.pending > 0) await nextFrame();
physics.flushColliders(); // terrain colliders are otherwise built a few per frame
$('loading').style.display = 'none';
prof.ready();

const timer = new THREE.Timer();
const loggedErrors = new Set();
let frames = 0, fpsT = 0, fps = 0;
renderer.setAnimationLoop((now) => {
    prof.frameStart(now);
    timer.update(now);
    const dt = Math.min(timer.getDelta(), 0.1);
    physics.step(dt);
    prof.mark('physics');
    // one failing system must not stop the game: log each distinct error once and keep running
    for(const s of systems) {
        try { s.update?.(dt); } catch(e) { if(!loggedErrors.has(e.message)) { loggedErrors.add(e.message); console.error(e); } }
        prof.mark(s.profileName);
    }
    env.update(); // after the camera moved: sky dome and shadow box follow it
    prof.mark('env');
    renderer.render(scene, camera);
    prof.mark('render');
    frames++; fpsT += dt;
    if(fpsT > 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; }
    $('stats').textContent = `${fps.toFixed(0)} fps · chunks ${terrain.meshes.size} · pending ${terrain.pending} · bodies ${physics.props.size} · soft ground: ${ctx.soft?.label ?? 'off'}${ctx.mpm?.enabled ? ` · grains ${ctx.mpm.stats.particles} (${ctx.mpm.label})` : ''}`;
    prof.frameEnd();
});
