/**
 * Input: keyboard + mouse (pointer lock) on desktop, twin-zone touch on mobile (left half: a floating move stick,
 * right half: drag to look, plus on-screen buttons the HUD creates and binds through `bindButton`).
 *
 * State read by the player each frame:
 *   move {x (right), y (forward)} in -1..1, consumeLook() -> [dx, dy] in radians, down(name), pressed(name) (edge,
 *   cleared by endFrame()), released(name).
 * Button names: fire, grab, punch, jump, sprint. Tool selection is a callback: onTool(index | 'next' | 'prev').
 */
export class Input {
    constructor(ctx) {
        this.ctx = ctx;
        this.canvas = ctx.renderer.domElement;
        const p = ctx.params;
        this.touch = p.get('touch') === '1' || (p.get('touch') !== '0' && (matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window));
        this.move = { x: 0, y: 0 };
        this.look = [0, 0];
        this.held = new Set();
        this.edges = new Set();
        this.ups = new Set();
        this.keys = new Set();
        this.sensitivity = 0.0022;
        this.touchSensitivity = 0.0055;
        this.toolFns = [];
        this.enabled = true;
        this.lockFns = [];
        if(this.touch) this.initTouch(); else this.initDesktop();
        const release = () => { this.keys.clear(); for(const b of [...this.held]) this.setButton(b, false); this.stick = null; this.lookId = null; this.move.x = this.move.y = 0; };
        addEventListener('blur', release);
        document.addEventListener('visibilitychange', () => { if(document.hidden) release(); });
    }
    onTool(fn) { this.toolFns.push(fn); }
    onLockChange(fn) { this.lockFns.push(fn); }
    tool(t) { for(const fn of this.toolFns) fn(t); }
    setButton(name, on) {
        if(on && !this.held.has(name)) { this.held.add(name); this.edges.add(name); }
        else if(!on && this.held.has(name)) { this.held.delete(name); this.ups.add(name); }
    }
    down(n) { return this.held.has(n); }
    pressed(n) { return this.edges.has(n); }
    released(n) { return this.ups.has(n); }
    consumeLook() { const l = [this.look[0], this.look[1]]; this.look[0] = this.look[1] = 0; return l; }
    endFrame() { this.edges.clear(); this.ups.clear(); }
    get locked() { return this.touch || document.pointerLockElement === this.canvas; }

    lock() {
        if(this.touch) return;
        try {
            const r = this.canvas.requestPointerLock({ unadjustedMovement: true });
            if(r && r.catch) r.catch(() => { try { this.canvas.requestPointerLock(); } catch(e) {} });
        } catch(e) { try { this.canvas.requestPointerLock(); } catch(e2) {} }
    }

    initDesktop() {
        const KEYMAP = { Space: 'jump', ShiftLeft: 'sprint', ShiftRight: 'sprint', KeyF: 'punch', KeyQ: 'punch', KeyE: 'grab' };
        addEventListener('keydown', (e) => {
            if(e.repeat) return;
            this.keys.add(e.code);
            if(KEYMAP[e.code]) this.setButton(KEYMAP[e.code], true);
            if(/^Digit[1-9]$/.test(e.code)) this.tool(+e.code.slice(5) - 1);
            if(e.code === 'Space' || e.code === 'Tab') e.preventDefault();
        });
        addEventListener('keyup', (e) => {
            this.keys.delete(e.code);
            if(KEYMAP[e.code]) this.setButton(KEYMAP[e.code], false);
        });
        this.canvas.addEventListener('click', () => { if(!this.locked && this.enabled) this.lock(); });
        document.addEventListener('pointerlockchange', () => { for(const fn of this.lockFns) fn(this.locked); });
        let fresh = true;
        addEventListener('mousemove', (e) => {
            if(!this.locked) { fresh = true; return; }
            const size = Math.max(Math.abs(e.movementX), Math.abs(e.movementY));
            if(size > 600 || (fresh && size > 50)) { fresh = false; return; }   // bogus jumps after locking
            fresh = false;
            this.look[0] += e.movementX * this.sensitivity; this.look[1] += e.movementY * this.sensitivity;
        });
        addEventListener('mousedown', (e) => {
            if(!this.locked) return;
            if(e.button === 0) this.setButton('fire', true);
            else if(e.button === 2) this.setButton('grab', true);
            else if(e.button === 1) { this.setButton('punch', true); e.preventDefault(); }
        });
        addEventListener('mouseup', (e) => {
            if(e.button === 0) this.setButton('fire', false);
            else if(e.button === 2) this.setButton('grab', false);
            else if(e.button === 1) this.setButton('punch', false);
        });
        addEventListener('wheel', (e) => { if(this.locked) this.tool(e.deltaY > 0 ? 'next' : 'prev'); }, { passive: true });
        addEventListener('contextmenu', (e) => e.preventDefault());
    }

    updateKeys() {
        if(this.touch) return;
        const k = this.keys;
        this.move.x = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
        this.move.y = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
        const l = Math.hypot(this.move.x, this.move.y); if(l > 1) { this.move.x /= l; this.move.y /= l; }
    }

    initTouch() {
        // the move stick: a ring and a knob that appear where the left thumb lands
        const ring = document.createElement('div'), knob = document.createElement('div');
        ring.className = 'stick-ring'; knob.className = 'stick-knob';
        document.body.append(ring, knob);
        this.stickEls = { ring, knob };
        const R = 60;
        this.stick = null; this.lookId = null; this.lookLast = null;
        const zone = this.canvas;
        const showStick = (on) => { ring.style.display = knob.style.display = on ? 'block' : 'none'; };
        showStick(false);
        zone.addEventListener('pointerdown', (e) => {
            if(e.clientX < innerWidth * 0.42 && !this.stick) {
                this.stick = { id: e.pointerId, x: e.clientX, y: e.clientY };
                ring.style.left = (e.clientX - R) + 'px'; ring.style.top = (e.clientY - R) + 'px';
                knob.style.left = (e.clientX - 24) + 'px'; knob.style.top = (e.clientY - 24) + 'px';
                showStick(true);
            } else if(this.lookId === null) { this.lookId = e.pointerId; this.lookLast = [e.clientX, e.clientY]; }
            try { zone.setPointerCapture(e.pointerId); } catch(err) {}
        });
        zone.addEventListener('pointermove', (e) => {
            if(this.stick && e.pointerId === this.stick.id) {
                let dx = e.clientX - this.stick.x, dy = e.clientY - this.stick.y;
                const l = Math.hypot(dx, dy);
                if(l > R) { // the stick follows a thumb that drifts past the ring
                    this.stick.x += dx / l * (l - R); this.stick.y += dy / l * (l - R);
                    ring.style.left = (this.stick.x - R) + 'px'; ring.style.top = (this.stick.y - R) + 'px';
                    dx = e.clientX - this.stick.x; dy = e.clientY - this.stick.y;
                }
                this.move.x = dx / R; this.move.y = -dy / R;
                this.held.has('sprint') || (Math.hypot(dx, dy) > R * 0.97 ? this.setButton('sprint', true) : null);
                if(Math.hypot(dx, dy) < R * 0.9) this.setButton('sprint', false);
                knob.style.left = (this.stick.x + dx - 24) + 'px'; knob.style.top = (this.stick.y + dy - 24) + 'px';
            } else if(e.pointerId === this.lookId) {
                this.look[0] += (e.clientX - this.lookLast[0]) * this.touchSensitivity;
                this.look[1] += (e.clientY - this.lookLast[1]) * this.touchSensitivity;
                this.lookLast = [e.clientX, e.clientY];
            }
        });
        const end = (e) => {
            if(this.stick && e.pointerId === this.stick.id) { this.stick = null; this.move.x = this.move.y = 0; this.setButton('sprint', false); showStick(false); }
            if(e.pointerId === this.lookId) this.lookId = null;
        };
        zone.addEventListener('pointerup', end);
        zone.addEventListener('pointercancel', end);
    }

    /** Wire an on-screen element as a held button (touch). */
    bindButton(el, name) {
        const on = (e) => { e.preventDefault(); e.stopPropagation(); this.setButton(name, true); el.classList.add('held'); };
        const off = (e) => { e.preventDefault(); e.stopPropagation(); this.setButton(name, false); el.classList.remove('held'); };
        el.addEventListener('pointerdown', on);
        el.addEventListener('pointerup', off);
        el.addEventListener('pointercancel', off);
        el.addEventListener('pointerleave', off);
    }
}
