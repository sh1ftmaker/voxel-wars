/** Music: "Gold Rush Heist" (assets/music/gold-rush-heist.mp3, from WorldParty's Undermine), looped under the game
 *  through the effects' master bus (so M mutes it). Streams from an <audio> element (decoding it whole would hold
 *  ~56 MB of samples). Fades in once audio starts; while dead it drops to half behind a lowpass; the last minute and
 *  carrying a crate push it a little louder. ?music=0 turns it off. */
const TRACK = 'assets/music/gold-rush-heist.mp3';
const LEVEL = 0.16;

export class Music {
    constructor(game, sfx) {
        this.game = game; this.sfx = sfx; this.started = false; this.state = '';
        this.enabled = game.ctx.params.get('music') !== '0';
        if(this.enabled) sfx.onReady(() => this.start());
        this.onVisibility = () => { if(!this.audio) return; if(document.hidden) this.audio.pause(); else this.play(); };
    }
    start() {
        if(this.started || !this.sfx.ready) return;
        try {
            const ctx = this.ctx = this.sfx.ctx;
            this.audio = new Audio(TRACK);
            this.audio.loop = true;
            this.lowpass = ctx.createBiquadFilter(); this.lowpass.type = 'lowpass'; this.lowpass.frequency.value = 18000; this.lowpass.Q.value = 0.3;
            this.bus = ctx.createGain(); this.bus.gain.value = 0;
            ctx.createMediaElementSource(this.audio).connect(this.lowpass);
            this.lowpass.connect(this.bus); this.bus.connect(this.sfx.master);
            document.addEventListener('visibilitychange', this.onVisibility);
            this.started = true;
            if(!document.hidden) this.play();
        } catch(e) { console.warn('music unavailable', e); }
    }
    play() { this.audio.play()?.then(() => { this.state = ''; }, (e) => { if(e?.name === 'NotAllowedError') { const retry = () => { removeEventListener('pointerdown', retry); this.play(); }; addEventListener('pointerdown', retry); } }); }
    update() {
        if(!this.started) return;
        const g = this.game, p = g.player;
        const dead = !p.alive || g.over;
        const hot = !dead && (p.carrying || g.timeLeft < 60);
        const s = dead ? 'dead' : hot ? 'hot' : 'calm';
        if(s === this.state) return;
        this.state = s;
        const t = this.ctx.currentTime;
        this.bus.gain.setTargetAtTime(LEVEL * (dead ? 0.5 : hot ? 1.35 : 1), t, 0.8);
        this.lowpass.frequency.setTargetAtTime(dead ? 600 : 18000, t, 0.6);
    }
}
