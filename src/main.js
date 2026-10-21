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
import { Level } from './level/fortwar.js';
import { TerrainRenderer } from './render/TerrainRenderer.js';
import { Environment, configureRenderer } from './render/Environment.js';
import { Physics } from './physics/Physics.js';
import { Destruction } from './physics/Destruction.js';
import { FlyCamera } from './dev/FlyCamera.js';
import { FortWar } from './game/FortWar.js';

const $ = (id) => document.getElementById(id);
const status = (s) => { $('loading').textContent = s; };
const nextFrame = () => new Promise(r => requestAnimationFrame(r));
const params = new URLSearchParams(location.search);

const renderer = new THREE.WebGPURenderer({ antialias: true });
await renderer.init();
configureRenderer(renderer); // pixel ratio per device, ACES, shadows (src/render/Environment.js)
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);

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
voxelize(world, new Level());
console.log(`voxelized in ${(performance.now() - t0).toFixed(0)} ms`);
const terrain = new TerrainRenderer(world, scene, camera);
status('Starting physics...');
const physics = await Physics.create({ world, terrain, scene });
terrain.remeshAll();

const systems = [];
const ctx = { renderer, scene, camera, sun, env, world, terrain, physics, params, events: new EventTarget(), addSystem: (s) => { systems.push(s); return s; } };
ctx.destruction = new Destruction(ctx);
window.ctx = ctx; // for debugging and headless tests

// ---- game systems are added here (one line each) ----
ctx.addSystem(params.get('fly') === '1' ? new FlyCamera(ctx) : new FortWar(ctx));

status('Meshing...');
while(terrain.pending > 0) await nextFrame();
physics.flushColliders(); // terrain colliders are otherwise built a few per frame
$('loading').style.display = 'none';

const timer = new THREE.Timer();
let frames = 0, fpsT = 0, fps = 0;
renderer.setAnimationLoop((now) => {
    timer.update(now);
    const dt = Math.min(timer.getDelta(), 0.1);
    physics.step(dt);
    for(const s of systems) s.update?.(dt);
    env.update(); // after the camera moved: sky dome and shadow box follow it
    renderer.render(scene, camera);
    frames++; fpsT += dt;
    if(fpsT > 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; }
    $('stats').textContent = `${fps.toFixed(0)} fps · chunks ${terrain.meshes.size} · pending ${terrain.pending} · bodies ${physics.props.size}`;
});
