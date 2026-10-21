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
import { Physics } from './physics/Physics.js';
import { Destruction } from './physics/Destruction.js';
import { FlyCamera } from './dev/FlyCamera.js';

const $ = (id) => document.getElementById(id);
const status = (s) => { $('loading').textContent = s; };
const nextFrame = () => new Promise(r => requestAnimationFrame(r));
const params = new URLSearchParams(location.search);

const renderer = new THREE.WebGPURenderer({ antialias: true });
await renderer.init();
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fc3e6);
scene.fog = new THREE.Fog(0xb8cfe4, 80, 260);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 500);
camera.position.set(-70, 14, 0);
scene.add(new THREE.HemisphereLight(0xd8e8ff, 0x8a7458, 1.6));
const sun = new THREE.DirectionalLight(0xfff1dd, 2.6);
sun.position.set(40, 80, 25);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -100, right: 100, top: 60, bottom: -60, near: 1, far: 250 });
sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.05;
scene.add(sun);
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
const ctx = { renderer, scene, camera, sun, world, terrain, physics, params, events: new EventTarget(), addSystem: (s) => { systems.push(s); return s; } };
ctx.destruction = new Destruction(ctx);
window.ctx = ctx; // for debugging and headless tests

// ---- game systems are added here (one line each) ----
ctx.addSystem(new FlyCamera(ctx));

status('Meshing...');
while(terrain.pending > 0) await nextFrame();
$('loading').style.display = 'none';

const timer = new THREE.Timer();
let frames = 0, fpsT = 0, fps = 0;
renderer.setAnimationLoop((now) => {
    timer.update(now);
    const dt = Math.min(timer.getDelta(), 0.1);
    physics.step(dt);
    for(const s of systems) s.update?.(dt);
    renderer.render(scene, camera);
    frames++; fpsT += dt;
    if(fpsT > 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; }
    $('stats').textContent = `${fps.toFixed(0)} fps · chunks ${terrain.meshes.size} · pending ${terrain.pending} · bodies ${physics.props.size}`;
});
