/** Summarize a profile file recorded in the game (?profile or F9; src/dev/Profiler.js).
 *  node tools/profile-report.mjs voxel-wars-profile-....json
 *  The same file opens as a timeline in https://ui.perfetto.dev. */
import fs from 'node:fs';
import { summarize } from '../src/dev/Profiler.js';

const file = process.argv[2];
if(!file) { console.log('usage: node tools/profile-report.mjs <profile.json>'); process.exit(1); }
const r = JSON.parse(fs.readFileSync(file, 'utf8'));
const s = summarize(r.frames), m = r.machine;
const row = (name, p) => p ? `${name.padEnd(14)} mean ${String(p.mean).padStart(7)}  p50 ${String(p.p50).padStart(7)}  p90 ${String(p.p90).padStart(7)}  p99 ${String(p.p99).padStart(7)}  max ${String(p.max).padStart(7)}` : `${name.padEnd(14)} n/a`;
console.log(`Recorded ${r.recorded}`);
console.log(`Browser   ${m.userAgent}`);
console.log(`Machine   ${m.platform}, ${m.cores} cores, ${m.memoryGB ?? '?'} GB, screen ${m.screen.join('x')} @${m.devicePixelRatio}, canvas ${m.canvas.join('x')} (pixel ratio ${m.pixelRatio})`);
console.log(`Renderer  ${m.backend}, GPU ${JSON.stringify(m.gpu)}${m.warning ? `\n!!        ${m.warning}` : ''}`);
if(r.load?.length) console.log(`Load      ${r.load.map(([n, t]) => `${n} ${(t / 1000).toFixed(1)}s`).join(', ')}`);
console.log(`\n${s.frames} frames, ${s.fps.toFixed(1)} fps average.  Verdict: ${s.verdict}\n`);
console.log('ms per frame');
console.log(row('interval', s.interval));
console.log(row('CPU (loop)', s.cpu));
console.log(row('GPU', s.gpu));
for(const [k, p] of Object.entries(s.sections)) console.log(row('  ' + k, p));
console.log(row('draw calls', s.drawCalls));
console.log(row('triangles', s.triangles));
console.log('\nWorst frames:');
for(const w of s.worst) console.log(`  t=${(w.t / 1000).toFixed(2)}s interval ${w.interval} ms, cpu ${w.cpu}, gpu ${w.gpu ?? 'n/a'}, bodies ${w.bodies}, pending meshes ${w.pending} ${JSON.stringify(w.sections)}`);
if(r.longTasks?.length) console.log(`\nLong tasks (>50 ms main thread): ${r.longTasks.length}, worst ${Math.max(...r.longTasks.map(t => t[1]))} ms`);
