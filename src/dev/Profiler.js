/**
 * Frame profiler that a player can run on their own machine and send back as one file.
 *
 *   ?profile        record 15 s of play once the world is ready, then offer the file (?profile=30 for 30 s)
 *   F9              start / stop a recording at any time (GPU times only with ?profile: timestamps must be
 *                   enabled when the renderer is created)
 *
 * Per frame it keeps: the frame interval (rAF to rAF), CPU time of each section of the main loop (physics, each
 * game system, env, render submission), GPU time when the backend can measure it (WebGPU timestamp queries, or
 * WebGL2's EXT_disjoint_timer_query), draw calls, triangles, physics bodies, pending meshes and JS heap. Plus the
 * machine: browser, OS, CPU cores, memory, screen, pixel ratio, rendering backend and the GPU's name (a software
 * renderer such as SwiftShader or llvmpipe shows up there and explains a 10 fps machine on its own).
 *
 * The file is JSON in Chrome's Trace Event format: open it in https://ui.perfetto.dev (or chrome://tracing) for a
 * timeline, or summarize it with `node tools/profile-report.mjs file.json`. Everything besides `traceEvents` is
 * ignored by those viewers and read by the report script.
 *
 * Main loop use: prof.frameStart(now); ... prof.mark('physics'); ... prof.frameEnd(). Marks cost two
 * performance.now() calls when not recording.
 */
const MAX_FRAMES = 60 * 240; // 60 s at 240 fps

export class Profiler {
    constructor({ renderer, params, ctx }) {
        this.renderer = renderer;
        this.ctx = ctx;
        this.recording = false;
        this.auto = params.has('profile') ? Math.max(3, Math.min(60, +params.get('profile') || 15)) : 0;
        this.gpuEnabled = params.has('profile');
        this.loadMarks = [];
        this.sections = new Map(); // name -> index
        this.frame = { start: 0, last: 0, marks: [] };
        this.prevStart = 0;
        this.gpuPending = false;
        this.longTasks = [];
        try {
            new PerformanceObserver((l) => { if(this.recording) for(const e of l.getEntries()) this.longTasks.push([+(e.startTime - this.t0).toFixed(1), +e.duration.toFixed(1)]); }).observe({ type: 'longtask', buffered: false });
        } catch(e) { /* not supported (Safari, Firefox) */ }
        addEventListener('keydown', (e) => { if(e.code === 'F9') { e.preventDefault(); this.recording ? this.stop() : this.start(this.auto || 15); } });
    }
    /** Timestamp a loading step (shown in the report). */
    loadMark(name) { this.loadMarks.push([name, +performance.now().toFixed(1)]); }

    /** Call when the game is playable; starts the automatic recording if ?profile asked for one. */
    ready() {
        this.loadMark('ready');
        if(this.auto) { this.banner(`Profiling ${this.auto} s... play normally`); setTimeout(() => this.start(this.auto), 1500); }
    }

    start(seconds) {
        if(this.recording) return;
        this.recording = true;
        this.t0 = performance.now();
        this.until = this.t0 + seconds * 1000;
        this.n = 0;
        this.cols = { t: new Float32Array(MAX_FRAMES), interval: new Float32Array(MAX_FRAMES), cpu: new Float32Array(MAX_FRAMES),
            gpu: new Float32Array(MAX_FRAMES).fill(NaN), calls: new Uint32Array(MAX_FRAMES), tris: new Uint32Array(MAX_FRAMES),
            bodies: new Uint16Array(MAX_FRAMES), pending: new Uint16Array(MAX_FRAMES), heap: new Float32Array(MAX_FRAMES) };
        this.sectionCols = [];
        this.longTasks = [];
        this.banner(`● Recording profile (${seconds} s)`);
    }
    stop() {
        if(!this.recording) return;
        this.recording = false;
        this.finish();
    }

    frameStart(now) {
        const f = this.frame;
        f.interval = this.prevStart ? now - this.prevStart : 0;
        this.prevStart = now;
        f.start = f.last = performance.now();
        f.marks.length = 0;
    }
    mark(name) {
        const t = performance.now(), f = this.frame;
        if(this.recording) f.marks.push(name, t - f.last);
        f.last = t;
    }
    frameEnd() {
        if(!this.recording) return;
        const f = this.frame, c = this.cols, i = this.n;
        if(i >= MAX_FRAMES || performance.now() > this.until) { this.stop(); return; }
        c.t[i] = f.start - this.t0;
        c.interval[i] = f.interval;
        c.cpu[i] = f.last - f.start;
        for(let k = 0; k < f.marks.length; k += 2) {
            let s = this.sections.get(f.marks[k]);
            if(s === undefined) { s = this.sections.size; this.sections.set(f.marks[k], s); }
            (this.sectionCols[s] ||= new Float32Array(MAX_FRAMES))[i] = f.marks[k + 1];
        }
        const info = this.renderer.info.render;
        c.calls[i] = info.drawCalls ?? info.calls ?? 0;
        c.tris[i] = info.triangles ?? 0;
        c.bodies[i] = this.ctx.physics?.props.size ?? 0;
        c.pending[i] = this.ctx.terrain?.pending ?? 0;
        c.heap[i] = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0;
        // GPU time of the passes submitted since the last resolve, attributed to this frame
        if(this.gpuEnabled && !this.gpuPending && this.renderer.backend.trackTimestamp) {
            this.gpuPending = true;
            this.renderer.resolveTimestampsAsync('render').then((ms) => { if(typeof ms === 'number' && i < MAX_FRAMES) c.gpu[i] = ms; }, () => {}).finally(() => { this.gpuPending = false; });
        }
        this.n++;
    }

    machine() {
        const r = this.renderer, b = r.backend, nav = navigator;
        const m = {
            url: location.href, userAgent: nav.userAgent, platform: nav.userAgentData?.platform || nav.platform,
            cores: nav.hardwareConcurrency, memoryGB: nav.deviceMemory, devicePixelRatio: devicePixelRatio,
            screen: [screen.width, screen.height], canvas: [r.domElement.width, r.domElement.height], pixelRatio: r.getPixelRatio(),
            backend: b.isWebGPUBackend ? 'WebGPU' : 'WebGL2',
        };
        try {
            if(b.isWebGPUBackend) {
                const info = b.adapter?.info || b.device?.adapterInfo;
                if(info) m.gpu = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description };
            } else {
                const gl = b.gl;
                const ext = gl.getExtension('WEBGL_debug_renderer_info');
                m.gpu = { vendor: gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR), renderer: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) };
                m.gpuTimer = !!gl.getExtension('EXT_disjoint_timer_query_webgl2');
            }
        } catch(e) { m.gpuError = String(e); }
        if(/swiftshader|llvmpipe|software|basic render/i.test(JSON.stringify(m.gpu || ''))) m.warning = 'software renderer: hardware acceleration is off or the GPU is blocklisted';
        return m;
    }

    finish() {
        const c = this.cols, n = this.n, names = [...this.sections.keys()];
        const frames = { t: [], interval: [], cpu: [], gpu: [], calls: [], tris: [], bodies: [], pending: [], heapMB: [], sections: {} };
        const r1 = (v) => Math.round(v * 100) / 100;
        for(let i = 0; i < n; i++) {
            frames.t.push(r1(c.t[i])); frames.interval.push(r1(c.interval[i])); frames.cpu.push(r1(c.cpu[i]));
            frames.gpu.push(Number.isNaN(c.gpu[i]) ? null : r1(c.gpu[i])); frames.calls.push(c.calls[i]); frames.tris.push(c.tris[i]);
            frames.bodies.push(c.bodies[i]); frames.pending.push(c.pending[i]); frames.heapMB.push(r1(c.heap[i]));
        }
        names.forEach((name, s) => { frames.sections[name] = Array.from(this.sectionCols[s]?.subarray(0, n) || [], r1); });
        // Chrome trace events (microseconds): a frame slice on the main track with its sections nested, GPU on its own
        const traceEvents = [
            { ph: 'M', name: 'process_name', pid: 1, args: { name: 'Voxel Wars' } },
            { ph: 'M', name: 'thread_name', pid: 1, tid: 1, args: { name: 'main thread' } },
            { ph: 'M', name: 'thread_name', pid: 1, tid: 2, args: { name: 'GPU (per resolve)' } },
        ];
        for(let i = 0; i < n; i++) {
            const ts = c.t[i] * 1000;
            traceEvents.push({ ph: 'X', pid: 1, tid: 1, name: 'frame', ts, dur: c.cpu[i] * 1000, args: { interval: r1(c.interval[i]) } });
            let at = ts;
            names.forEach((name, s) => { const d = this.sectionCols[s]?.[i] || 0; if(d > 0) traceEvents.push({ ph: 'X', pid: 1, tid: 1, name, ts: at, dur: d * 1000 }); at += d * 1000; });
            if(!Number.isNaN(c.gpu[i])) traceEvents.push({ ph: 'X', pid: 1, tid: 2, name: 'gpu', ts, dur: c.gpu[i] * 1000 });
            if(i % 10 === 0) traceEvents.push({ ph: 'C', pid: 1, name: 'fps', ts, args: { fps: c.interval[i] > 0 ? Math.round(1000 / c.interval[i]) : 0 } });
        }
        for(const [start, dur] of this.longTasks) traceEvents.push({ ph: 'X', pid: 1, tid: 3, name: 'long task', ts: start * 1000, dur: dur * 1000 });
        const report = { format: 'voxel-wars-profile', version: 1, recorded: new Date().toISOString(), machine: this.machine(), load: this.loadMarks, summary: summarize(frames), frames, longTasks: this.longTasks, traceEvents };
        this.offer(report);
    }

    // ---- UI ----
    banner(text) {
        let b = this.bannerEl;
        if(!b) {
            b = this.bannerEl = document.createElement('div');
            b.style.cssText = 'position:fixed;top:10px;right:10px;z-index:1000;background:rgba(16,20,28,.85);color:#fff;font:13px system-ui;padding:8px 12px;border-radius:8px;max-width:340px;pointer-events:auto';
            document.body.appendChild(b);
        }
        b.textContent = text;
        return b;
    }
    offer(report) {
        const s = report.summary, m = report.machine;
        const json = JSON.stringify(report);
        const name = `voxel-wars-profile-${report.recorded.replace(/[:.]/g, '-').slice(0, 19)}.json`;
        const b = this.banner('');
        b.innerHTML = `<b>Profile recorded</b><br>${s.frames} frames · ${s.fps.toFixed(0)} fps avg · p99 frame ${s.interval.p99} ms<br>`
            + `CPU p50 ${s.cpu.p50} ms · GPU p50 ${s.gpu ? s.gpu.p50 + ' ms' : 'n/a'}<br><small>${m.backend} · ${(m.gpu && (m.gpu.renderer || m.gpu.description || m.gpu.vendor)) || 'unknown GPU'}</small><br>`
            + `<button data-a="dl">Download profile</button> <button data-a="copy">Copy summary</button> <button data-a="close">✕</button>`;
        for(const btn of b.querySelectorAll('button')) btn.style.cssText = 'margin-top:6px;padding:5px 9px;border-radius:6px;border:0;background:#f0a640;color:#111;font:inherit;cursor:pointer';
        b.querySelector('[data-a=dl]').onclick = () => {
            const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
            const a = Object.assign(document.createElement('a'), { href: url, download: name });
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        };
        b.querySelector('[data-a=copy]').onclick = () => {
            const text = JSON.stringify({ machine: report.machine, load: report.load, summary: report.summary }, null, 1);
            navigator.clipboard?.writeText(text).then(() => { b.querySelector('[data-a=copy]').textContent = 'Copied'; }, () => prompt('Copy this:', text));
        };
        b.querySelector('[data-a=close]').onclick = () => { b.remove(); this.bannerEl = null; };
        if(document.pointerLockElement) document.exitPointerLock();
        window.lastProfile = report; // for headless tests
        console.log('[profile]', JSON.stringify(report.summary));
    }
}

/** Percentiles and per-section breakdown; shared with tools/profile-report.mjs via the same shape. */
export function summarize(frames) {
    const pct = (arr) => {
        const a = arr.filter(v => v != null && !Number.isNaN(v)).sort((x, y) => x - y);
        if(!a.length) return null;
        const q = (p) => +a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(2);
        return { mean: +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2), p50: q(0.5), p90: q(0.9), p99: q(0.99), max: +a[a.length - 1].toFixed(2) };
    };
    const iv = frames.interval.slice(1);
    const interval = pct(iv), cpu = pct(frames.cpu), gpu = pct(frames.gpu);
    const sections = {};
    for(const [k, v] of Object.entries(frames.sections)) sections[k] = pct(v);
    let verdict = 'smooth';
    // the frame interval sits on a display refresh period while CPU and GPU have room: vsync, not slowness
    const refresh = interval && [1000 / 30, 1000 / 60, 1000 / 75, 1000 / 90, 1000 / 120, 1000 / 144, 1000 / 165, 1000 / 240].find(p => Math.abs(interval.p50 - p) < p * 0.06);
    const busy = Math.max(cpu?.p50 || 0, gpu?.p50 || 0);
    if(refresh && busy < interval.p50 * 0.6) verdict = `capped by the display refresh (${Math.round(1000 / refresh)} Hz vsync); CPU and GPU have headroom` + (interval.p99 > 3 * interval.p50 ? ', with hitches (see worst frames)' : '');
    else if(interval && interval.p50 > 12) {
        if(gpu && gpu.p50 > interval.p50 * 0.6) verdict = 'GPU-bound: the GPU takes most of each frame';
        else if(cpu && cpu.p50 > interval.p50 * 0.6) verdict = 'CPU-bound: the main loop takes most of each frame (see sections)';
        else verdict = 'frame interval far above CPU time: likely GPU-bound (GPU time unavailable) or the browser is throttling';
    } else if(interval && interval.p99 > 3 * interval.p50) verdict = 'mostly smooth with hitches (see worst frames)';
    const worst = frames.interval.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, 10).map(([v, i]) => {
        const s = {}; for(const [k, arr] of Object.entries(frames.sections)) if(arr[i] > 0.3) s[k] = arr[i];
        return { t: frames.t[i], interval: v, cpu: frames.cpu[i], gpu: frames.gpu[i], sections: s, bodies: frames.bodies[i], pending: frames.pending[i] };
    });
    return { frames: frames.t.length, fps: interval ? 1000 / interval.mean : 0, interval, cpu, gpu, sections, verdict,
        drawCalls: pct(frames.calls), triangles: pct(frames.tris), worst };
}
