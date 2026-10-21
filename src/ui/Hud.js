/**
 * The HUD (DOM over the canvas): score and match clock, health, tool bar with cooldowns (and the mason's stone, the
 * buster count), crosshair with hit markers and the grenade charge, hints and an event feed, a damage vignette,
 * world markers (crates, your vault when carrying, enemy health), the click-to-play, death and match-over screens,
 * and the touch buttons on mobile. DOM writes only when a value changes.
 */
import * as THREE from 'three/webgpu';
import { WEAPONS, TOOLS, MASON_SHAPES } from '../game/weapons/defs.js';
import { HUD_CSS } from './hudStyle.js';

const el = (tag, cls, parent, html) => { const e = document.createElement(tag); if(cls) e.className = cls; if(html != null) e.innerHTML = html; if(parent) parent.appendChild(e); return e; };
const fmtTime = (s) => { s = Math.ceil(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const _v = new THREE.Vector3();

export class Hud {
    constructor(game) {
        this.game = game;
        const style = document.createElement('style'); style.textContent = HUD_CSS; document.head.appendChild(style);
        const root = this.root = el('div', 'bz-hud', document.body);
        if(game.input.touch) root.classList.add('touch');
        const old = document.getElementById('crosshair'); if(old) old.style.display = 'none';
        // top: score
        const top = el('div', 'bz-score', root);
        this.redEl = el('div', 'team red', top, '<span class="n">0</span><span class="lbl">RED</span>');
        this.clockEl = el('div', 'clock', top, '10:00');
        this.blueEl = el('div', 'team blue', top, '<span class="lbl">BLUE</span><span class="n">0</span>');
        this.redN = this.redEl.querySelector('.n'); this.blueN = this.blueEl.querySelector('.n');
        this.feed = el('div', 'bz-feed', root);
        // crosshair
        this.cross = el('div', 'bz-cross', root, '<i></i><i></i><i></i><i></i>');
        this.hitEl = el('div', 'bz-hit', root, '<i></i><i></i><i></i><i></i>');
        this.chargeEl = el('div', 'bz-charge', root);
        // bottom left: health, carrying
        const hp = el('div', 'bz-health', root);
        this.hpBar = el('div', 'bar', hp); this.hpFill = el('div', 'fill', this.hpBar); this.hpText = el('div', 'txt', hp, '100');
        this.carryEl = el('div', 'bz-carry', root, '📦 Carrying a crate: get it to your vault (under your fort)');
        // tool bar
        const bar = this.bar = el('div', 'bz-tools', root);
        this.slots = TOOLS.map((t, i) => {
            const s = el('div', 'slot', bar, `<div class="icon">${WEAPONS[t].icon}</div><div class="key">${i + 1}</div><div class="cd"></div><div class="sub"></div>`);
            s.title = WEAPONS[t].name;
            s.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); game.player.arsenal.select(i); });
            return { el: s, cd: s.querySelector('.cd'), sub: s.querySelector('.sub'), last: {} };
        });
        this.toolName = el('div', 'bz-toolname', root);
        this.hintEl = el('div', 'bz-hint', root);
        this.vignette = el('div', 'bz-vignette', root);
        this.markers = [];
        this.markerLayer = el('div', 'bz-markers', root);
        // screens
        this.playEl = el('div', 'bz-screen bz-play', root, `<div class="card"><h1>VOXEL WARS</h1><p>Steal supply crates and bank them in your vault, under your fort. Blue's bots tunnel through everything to do the same.</p>
            <div class="keys"><b>WASD</b> move · <b>Space</b> jump · <b>Shift</b> sprint<br><b>Click</b> use tool · <b>1-7 / wheel</b> tools<br><b>F</b> punch · hold <b>E / right click</b> rip & throw · <b>M</b> mute</div><button>Click to play</button><div><button class="bz-bots small"></button></div><div class="bz-softinfo"></div></div>`);
        this.softInfo = this.playEl.querySelector('.bz-softinfo');
        this.botsCorner = el('button', 'bz-bots corner', root);
        this.botButtons = [...root.querySelectorAll('.bz-bots')];
        for(const b of this.botButtons) b.addEventListener('click', (e) => { e.stopPropagation(); game.setBots(!game.botsOn); });
        this.playEl.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); game.input.lock(); });
        this.playEl.addEventListener('click', () => game.input.lock());
        this.deadEl = el('div', 'bz-screen bz-dead', root, '<div class="big">YOU DIED</div><div class="sub"></div>');
        this.deadSub = this.deadEl.querySelector('.sub');
        this.overEl = el('div', 'bz-screen bz-over', root, '<div class="card"><h1></h1><p class="res"></p><button>Play again</button></div>');
        this.overEl.querySelector('button').addEventListener('click', () => game.restart());
        if(game.input.touch) this.makeTouchButtons();
        // events
        this.hintT = 0; this.hitT = 0; this.dmgT = 0;
        game.on('hint', ({ text, long }) => this.hint(text, long ? 7 : 2.5));
        game.on('damage', ({ actor, amount, by }) => {
            if(actor === game.player) { this.dmgT = Math.min(1, this.dmgT + amount / 50); }
            else if(by === game.player) { this.hitT = 0.25; this.hitEl.classList.toggle('kill', actor.health <= 0); }
        });
        game.on('death', ({ actor, by, cause }) => {
            const how = cause === 'fell' ? 'fell out of the world' : cause === 'punch' ? 'was punched out' : cause === 'rock' ? 'was flattened by a boulder' : cause === 'grenade' ? 'was fragged' : cause === 'buster' ? 'was busted' : 'was blown up';
            const who = (a) => `<span class="${a.team}">${a.name}</span>`;
            this.feedMsg(by && by !== actor ? `${who(by)} ⟶ ${who(actor)}` : `${who(actor)} ${how}`);
        });
        game.on('pickup', ({ actor, from }) => {
            if(actor === game.player) this.hint(from === 'blue' ? 'Stolen! Run it home to your vault' : 'Got a crate! Run it home to your vault', 3);
            else if(from === 'red') this.feedMsg(`<span class="blue">${actor.name}</span> is stealing from your vault!`, true);
        });
        game.on('deposit', ({ actor }) => this.feedMsg(actor.team === 'red' ? `<span class="red">${actor.name}</span> banked a crate +1` : `<span class="blue">${actor.name}</span> banked a crate for Blue`, actor.team !== 'red'));
        game.on('matchOver', ({ result, score }) => {
            this.overEl.classList.add('on');
            this.overEl.querySelector('h1').textContent = result === 'win' ? 'VICTORY' : result === 'loss' ? 'DEFEAT' : 'DRAW';
            this.overEl.querySelector('.res').innerHTML = `Red <b>${score.red}</b> : <b>${score.blue}</b> Blue<br><small>Your kills ${game.player.kills} · deaths ${game.player.deaths}</small>`;
        });
        game.input.onLockChange(() => this.update(0));
        this.last = {};
        this.specs = []; this.nSpecs = 0; this.pickT = 0; this.bestCrates = [null, null, null, null]; this.bestD = new Float64Array(4);
    }
    makeTouchButtons() {
        const g = this.game, pad = el('div', 'bz-touch', this.root);
        const b = (cls, label, name) => { const e = el('div', 'tbtn ' + cls, pad, label); g.input.bindButton(e, name); return e; };
        b('fire', '🔥', 'fire'); b('jump', '⤒', 'jump'); b('grab', '✊', 'grab'); b('punch', '👊', 'punch');
    }
    hint(text, t = 2.5) { this.hintEl.textContent = text; this.hintEl.classList.add('on'); this.hintT = t; }
    feedMsg(html, bad = false) {
        const m = el('div', 'msg' + (bad ? ' bad' : ''), this.feed, html);
        setTimeout(() => m.classList.add('fade'), 4500);
        setTimeout(() => m.remove(), 5200);
        while(this.feed.children.length > 5) this.feed.firstChild.remove();
    }
    set(key, v, fn) { if(this.last[key] !== v) { this.last[key] = v; fn(v); } }
    /** Cheap change check without a closure: true (and remembered) when `v` differs from last time. */
    changed(key, v) { if(this.last[key] === v) return false; this.last[key] = v; return true; }

    update(dt) {
        const g = this.game, p = g.player, a = p.arsenal, L = this.last;
        if(this.changed('red', g.score.red)) this.redN.textContent = g.score.red;
        if(this.changed('blue', g.score.blue)) this.blueN.textContent = g.score.blue;
        const secs = Math.ceil(g.timeLeft);
        if(this.changed('clock', secs)) { this.clockEl.textContent = fmtTime(secs); this.clockEl.classList.toggle('urgent', secs <= 60); }
        const hp = Math.ceil(p.health);
        const soft = g.ctx.soft;
        if(soft && this.changed('soft', soft.label)) this.softInfo.textContent = `Soft tetrahedral ground: ${soft.label}${soft.enabled ? ' · F7 shows the tets' : ''}`;
        if(this.changed('hp', hp)) { this.hpFill.style.width = hp + '%'; this.hpText.textContent = hp; this.hpBar.classList.toggle('low', hp < 35); }
        if(this.changed('carry', !!p.carrying)) this.carryEl.classList.toggle('on', !!p.carrying);
        // tools
        for(let i = 0; i < TOOLS.length; i++) {
            const t = TOOLS[i], s = this.slots[i], sl = s.last;
            const active = i === a.index, cdv = Math.round(a.coolFrac(t) * 20) / 20;
            if(sl.active !== active) { sl.active = active; s.el.classList.toggle('active', active); }
            if(sl.cd !== cdv) { sl.cd = cdv; s.cd.style.height = (cdv * 100) + '%'; }
            if(t === 'mason') { const st = Math.floor(p.stone); if(sl.sub !== st) { sl.sub = st; s.sub.textContent = st + 'm³'; } }
            else if(t === 'buster' && sl.sub !== p.busters) { sl.sub = p.busters; s.sub.textContent = '×' + p.busters; s.el.classList.toggle('empty', p.busters <= 0); }
        }
        if(this.changed('tool', a.tool) | this.changed('shape', a.masonShape))
            this.toolName.textContent = a.tool === 'mason' ? `${WEAPONS.mason.name}: ${MASON_SHAPES[a.masonShape].name} (press 6 again to switch)` : WEAPONS[a.tool].name;
        // crosshair, hit marker, charge
        this.hitT -= dt;
        if(this.changed('hit', this.hitT > 0)) this.hitEl.classList.toggle('on', this.hitT > 0);
        const ch = a.charging ? Math.round(a.charge * 20) / 20 : 0;
        if(this.changed('charge', ch)) { this.chargeEl.style.display = ch > 0 ? 'block' : 'none'; this.chargeEl.style.background = `conic-gradient(#ffd060 ${ch * 360}deg, rgba(255,255,255,.15) 0)`; }
        // damage vignette
        this.dmgT = Math.max(0, this.dmgT - dt * 1.2);
        const lowHp = p.alive && p.health < 35 ? 0.25 + Math.sin(performance.now() / 250) * 0.08 : 0;
        const vg = Math.round(Math.max(this.dmgT, lowHp) * 40) / 40;
        if(this.changed('vg', vg)) this.vignette.style.opacity = vg;
        if(this.hintT > 0) { this.hintT -= dt; if(this.hintT <= 0) this.hintEl.classList.remove('on'); }
        // screens
        const showPlay = !g.input.locked && !g.over;
        if(this.changed('play', showPlay)) this.playEl.classList.toggle('on', showPlay);
        const dead = !p.alive && !g.over;
        if(this.changed('dead', dead)) this.deadEl.classList.toggle('on', dead);
        if(dead) { const r = Math.ceil(p.respawnIn); if(this.changed('respawn', r)) this.deadSub.textContent = `Respawning in ${r}…`; }
        if(this.changed('bots', g.botsOn)) for(const b of this.botButtons) b.textContent = g.botsOn ? '🤖 Bots: ON' : '🤖 Bots: OFF';
        this.pickT -= dt;
        if(this.pickT <= 0) { this.pickT = 0.15; this.pickMarkers(); }
        this.drawMarkers();
    }

    /** Which markers to show (a few times a second): the nearest crates you could take, your vault while carrying,
     *  enemies nearby that are hurt or see you. Fills reused spec objects; drawMarkers projects them every frame. */
    pickMarkers() {
        const g = this.game, p = g.player, me = p.body.center, specs = this.specs;
        let n = 0;
        const add = () => { if(n >= specs.length) specs.push({ src: null, kind: '', cls: '', label: '', d: 0, hp: -1, noClamp: false }); return specs[n++]; };
        if(p.carrying) { const s = add(); s.src = null; s.kind = 'vault'; s.cls = 'vault'; s.label = 'VAULT'; s.d = -1; s.hp = -1; s.noClamp = false; }
        else {
            // the 4 nearest takeable crates, by insertion into a small sorted buffer (no array churn)
            const best = this.bestCrates, bd = this.bestD; let k = 0;
            for(const c of g.crates.list) {
                if(c.vault === 'red' || c.carrier === p) continue;
                const t = c.carrier ? c.carrier.body.center : c.prop.body.translation();
                const d = Math.hypot(t.x - me.x, t.y - me.y, t.z - me.z);
                let j = Math.min(k, 4);
                if(j === 4 && d >= bd[3]) continue;
                if(j === 4) j = 3;
                while(j > 0 && bd[j - 1] > d) { bd[j] = bd[j - 1]; best[j] = best[j - 1]; j--; }
                bd[j] = d; best[j] = c; if(k < 4) k++;
            }
            for(let i = 0; i < k; i++) {
                const c = best[i], s = add();
                s.src = c; s.kind = 'crate'; s.d = bd[i]; s.hp = -1; s.noClamp = false;
                s.cls = c.carrier ? 'stolen' : c.vault === 'blue' ? 'enemy' : c.buried ? 'buried' : 'crate';
                s.label = c.carrier ? '⚠' : c.buried ? '⛏' : '📦';
            }
        }
        for(const b of g.bots) {
            if(!b.alive) continue;
            const c = b.body.center, d = Math.hypot(c.x - me.x, c.y - me.y, c.z - me.z);
            if(d < 32 && (b.health < 100 || b.seesPlayer)) { const s = add(); s.src = b; s.kind = 'bot'; s.cls = 'bot'; s.label = ''; s.d = d; s.hp = b.health; s.noClamp = true; }
        }
        this.nSpecs = n;
    }

    drawMarkers() {
        const g = this.game, cam = g.ctx.camera, W = innerWidth, H = innerHeight;
        while(this.markers.length < this.nSpecs) this.markers.push({ el: el('div', 'mk', this.markerLayer, '<span class="l"></span><span class="d"></span><div class="hpb"><i></i></div>'), key: '', px: -1, py: -1, shown: true });
        for(let i = 0; i < this.markers.length; i++) {
            const m = this.markers[i], o = i < this.nSpecs ? this.specs[i] : null;
            let show = !!o;
            if(o) {
                if(o.kind === 'vault') { const v = g.crates.vaults.red; _v.set((v.min[0] + v.max[0]) / 2, (v.min[1] + v.max[1]) / 2, (v.min[2] + v.max[2]) / 2); }
                else if(o.kind === 'crate') { const c = o.src; if(c.carrier) _v.copy(c.carrier.body.center).y += 1.4; else { const t = c.prop.body.translation(); _v.set(t.x, t.y + 0.6, t.z); } }
                else { const c = o.src.body.center; _v.set(c.x, c.y + 1.3, c.z); if(!o.src.alive) show = false; }
                _v.project(cam);
                let x = _v.x, y = _v.y;
                const behind = _v.z > 1;
                if(behind) { x = -x; y = -y; }
                const off = behind || Math.abs(x) > 0.92 || y > 0.86 || y < -0.62;
                if(off && o.noClamp) show = false;
                else {
                    if(off) { const k = Math.max(Math.abs(x) / 0.92, y > 0 ? y / 0.86 : -y / 0.62); x /= k; y /= k; }
                    const px = Math.round((x + 1) / 2 * W), py = Math.round((1 - y) / 2 * H);
                    if(px !== m.px || py !== m.py) { m.px = px; m.py = py; m.el.style.transform = `translate(${px}px, ${py}px)`; }
                    const key = o.cls + (off ? ' off' : '');
                    if(m.key !== key) { m.key = key; m.el.className = 'mk ' + key; }
                    if(m.lbl !== o.label) { m.lbl = o.label; m.el.children[0].textContent = o.label; }
                    const dd = o.d >= 0 ? Math.round(o.d) : -1;
                    if(m.dd !== dd) { m.dd = dd; m.el.children[1].textContent = dd >= 0 ? dd + 'm' : ''; }
                    if(o.hp >= 0 && m.hp !== Math.round(o.src.health)) { m.hp = Math.round(o.src.health); m.el.children[2].firstChild.style.width = Math.max(0, m.hp) + '%'; }
                }
            }
            if(m.shown !== show) { m.shown = show; m.el.style.display = show ? '' : 'none'; }
        }
    }
}
