/** HUD styles (injected by Hud.js). Mobile layout under .touch. */
export const HUD_CSS = `
.bz-hud { position: fixed; inset: 0; pointer-events: none; z-index: 20; font: 600 14px/1.25 system-ui, -apple-system, Segoe UI, sans-serif; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.6); }
.bz-hud .red { color: #ff6a5c; } .bz-hud .blue { color: #6aa8ff; }
.bz-score { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); display: flex; align-items: stretch; gap: 0; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,.3); }
.bz-score .team { display: flex; align-items: center; gap: 8px; padding: 4px 14px; font-size: 13px; letter-spacing: .08em; }
.bz-score .team .n { font-size: 26px; font-weight: 800; color: #fff; }
.bz-score .team.red { background: linear-gradient(#e0453a, #b02a20); color: #ffd8d2; }
.bz-score .team.blue { background: linear-gradient(#3a7be0, #2350a8); color: #d8e6ff; }
.bz-score .clock { background: rgba(16,20,28,.82); padding: 4px 16px; font-size: 22px; font-weight: 800; font-variant-numeric: tabular-nums; display: flex; align-items: center; }
.bz-score .clock.urgent { color: #ffcf40; animation: bzpulse 1s infinite; }
@keyframes bzpulse { 50% { color: #ff5040; } }
.bz-feed { position: absolute; top: 64px; right: 12px; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.bz-feed .msg { background: rgba(16,20,28,.65); padding: 4px 10px; border-radius: 6px; transition: opacity .6s; font-size: 13px; }
.bz-feed .msg.bad { background: rgba(120,20,20,.7); }
.bz-feed .msg.fade { opacity: 0; }
.bz-cross { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.bz-cross i, .bz-hit i { position: absolute; background: #fff; box-shadow: 0 0 2px #000; }
.bz-cross i:nth-child(1) { left: -1px; top: -11px; width: 2px; height: 7px; } .bz-cross i:nth-child(2) { left: -1px; top: 4px; width: 2px; height: 7px; }
.bz-cross i:nth-child(3) { left: -11px; top: -1px; width: 7px; height: 2px; } .bz-cross i:nth-child(4) { left: 4px; top: -1px; width: 7px; height: 2px; }
.bz-hit { position: absolute; left: 50%; top: 50%; width: 0; height: 0; opacity: 0; transition: opacity .08s; }
.bz-hit.on { opacity: 1; }
.bz-hit i { width: 9px; height: 2px; background: #fff; }
.bz-hit.kill i { background: #ff4030; }
.bz-hit i:nth-child(1) { transform: translate(5px, 5px) rotate(45deg); } .bz-hit i:nth-child(2) { transform: translate(-14px, 5px) rotate(-45deg); }
.bz-hit i:nth-child(3) { transform: translate(5px, -7px) rotate(-45deg); } .bz-hit i:nth-child(4) { transform: translate(-14px, -7px) rotate(45deg); }
.bz-charge { display: none; position: absolute; left: 50%; top: 50%; width: 34px; height: 34px; margin: -17px; border-radius: 50%; -webkit-mask: radial-gradient(circle, transparent 13px, #000 14px); mask: radial-gradient(circle, transparent 13px, #000 14px); }
.bz-health { position: absolute; left: 14px; bottom: 16px; display: flex; align-items: center; gap: 8px; }
.bz-health .bar { width: 200px; height: 16px; border-radius: 8px; background: rgba(16,20,28,.6); overflow: hidden; border: 2px solid rgba(255,255,255,.25); }
.bz-health .fill { height: 100%; width: 100%; background: linear-gradient(#7be05a, #3fa82a); transition: width .15s; }
.bz-health .bar.low .fill { background: linear-gradient(#ff6a50, #c02a20); }
.bz-health .txt { font-size: 20px; font-weight: 800; min-width: 36px; }
.bz-carry { position: absolute; left: 50%; bottom: 112px; transform: translateX(-50%); background: rgba(200,140,40,.85); padding: 6px 14px; border-radius: 8px; display: none; white-space: nowrap; }
.bz-carry.on { display: block; animation: bzbob 1s ease-in-out infinite; }
@keyframes bzbob { 50% { transform: translateX(-50%) translateY(-3px); } }
.bz-tools { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); display: flex; gap: 6px; pointer-events: auto; }
.bz-tools .slot { position: relative; width: 54px; height: 54px; border-radius: 10px; background: rgba(16,20,28,.6); border: 2px solid rgba(255,255,255,.18); overflow: hidden; display: grid; place-items: center; cursor: pointer; }
.bz-tools .slot.active { border-color: #ffd060; background: rgba(60,48,16,.75); transform: translateY(-4px); box-shadow: 0 0 12px rgba(255,200,60,.5); }
.bz-tools .slot.empty { opacity: .4; }
.bz-tools .icon { font-size: 26px; text-shadow: none; }
.bz-tools .key { position: absolute; left: 4px; top: 1px; font-size: 11px; opacity: .8; }
.bz-tools .sub { position: absolute; right: 3px; bottom: 1px; font-size: 10px; }
.bz-tools .cd { position: absolute; left: 0; right: 0; bottom: 0; height: 0; background: rgba(0,0,0,.55); }
.bz-toolname { position: absolute; left: 50%; bottom: 76px; transform: translateX(-50%); font-size: 13px; opacity: .9; white-space: nowrap; }
.bz-hint { position: absolute; left: 50%; top: 62%; transform: translateX(-50%); background: rgba(16,20,28,.7); padding: 6px 14px; border-radius: 8px; opacity: 0; transition: opacity .3s; max-width: 90vw; text-align: center; }
.bz-hint.on { opacity: 1; }
.bz-vignette { position: absolute; inset: 0; opacity: 0; background: radial-gradient(ellipse at center, transparent 45%, rgba(200,0,0,.75) 100%); }
.bz-markers { position: absolute; inset: 0; overflow: hidden; }
.bz-markers .mk { position: absolute; left: 0; top: 0; display: flex; flex-direction: column; align-items: center; margin: -14px 0 0 -30px; width: 60px; font-size: 12px; }
.bz-markers .mk .l { font-size: 18px; filter: drop-shadow(0 0 3px rgba(255,200,60,.9)); }
.bz-markers .mk.vault .l { font-size: 13px; background: #e0453a; padding: 1px 6px; border-radius: 4px; filter: none; }
.bz-markers .mk.enemy .l { filter: drop-shadow(0 0 4px #3a7be0); }
.bz-markers .mk.stolen .l { color: #ff4030; font-size: 20px; }
.bz-markers .mk.off { opacity: .75; }
.bz-markers .mk .hpb { display: none; width: 44px; height: 5px; background: rgba(0,0,0,.5); border-radius: 3px; overflow: hidden; }
.bz-markers .mk.bot .hpb { display: block; } .bz-markers .mk .hpb i { display: block; height: 100%; width: 100%; background: #6aa8ff; }
.bz-screen { position: absolute; inset: 0; display: none; place-items: center; }
.bz-screen.on { display: grid; }
.bz-screen .card { background: rgba(16,20,28,.86); border-radius: 16px; padding: 22px 28px; max-width: 460px; text-align: center; pointer-events: auto; box-shadow: 0 8px 40px rgba(0,0,0,.4); }
.bz-screen h1 { margin: 0 0 8px; font-size: 38px; letter-spacing: .08em; color: #ffd060; }
.bz-screen p { font-weight: 500; opacity: .92; }
.bz-screen .keys { font-weight: 500; font-size: 13px; opacity: .85; margin: 10px 0 16px; line-height: 1.6; }
.bz-screen button { font: 800 18px system-ui, sans-serif; padding: 10px 26px; border-radius: 10px; border: 0; background: #ffd060; color: #2a1e08; cursor: pointer; }
.bz-play { background: rgba(10,14,20,.35); pointer-events: auto; cursor: pointer; }
.bz-dead { background: radial-gradient(ellipse at center, rgba(80,0,0,.15), rgba(80,0,0,.55)); }
.bz-dead .big { font-size: 44px; font-weight: 900; color: #ff5a4a; letter-spacing: .1em; text-align: center; }
.bz-dead .sub { text-align: center; font-size: 16px; }
.bz-over { background: rgba(10,14,20,.5); pointer-events: auto; }
.bz-over .res { font-size: 22px; }
.stick-ring { position: fixed; width: 120px; height: 120px; border-radius: 50%; border: 3px solid rgba(255,255,255,.35); background: rgba(255,255,255,.08); pointer-events: none; z-index: 25; }
.stick-knob { position: fixed; width: 48px; height: 48px; border-radius: 50%; background: rgba(255,255,255,.45); pointer-events: none; z-index: 26; }
.bz-touch { position: absolute; right: 0; bottom: 0; width: 230px; height: 260px; pointer-events: none; }
.bz-touch .tbtn { position: absolute; pointer-events: auto; border-radius: 50%; background: rgba(16,20,28,.45); border: 2px solid rgba(255,255,255,.35); display: grid; place-items: center; font-size: 26px; touch-action: none; }
.bz-touch .tbtn.held { background: rgba(255,208,96,.55); }
.bz-touch .fire { width: 84px; height: 84px; right: 22px; bottom: 96px; font-size: 34px; }
.bz-touch .jump { width: 64px; height: 64px; right: 120px; bottom: 30px; }
.bz-touch .grab { width: 58px; height: 58px; right: 118px; bottom: 132px; }
.bz-touch .punch { width: 58px; height: 58px; right: 34px; bottom: 196px; }
.bz-hud.touch .bz-tools { left: 12px; transform: none; bottom: auto; top: 72px; gap: 4px; }
.bz-hud.touch .bz-tools .slot { width: 40px; height: 40px; border-radius: 8px; } .bz-hud.touch .bz-tools .slot.active { transform: translateY(2px); }
.bz-hud.touch .bz-tools .icon { font-size: 19px; } .bz-hud.touch .bz-tools .key { display: none; }
.bz-hud.touch .bz-toolname { left: 12px; top: 118px; bottom: auto; transform: none; font-size: 12px; }
.bz-hud.touch .bz-health { bottom: auto; top: 44px; left: 12px; } .bz-hud.touch .bz-health .bar { width: 120px; height: 12px; } .bz-hud.touch .bz-health .txt { font-size: 15px; }
.bz-hud.touch .bz-score { top: 8px; } .bz-hud.touch .bz-score .team .n { font-size: 20px; } .bz-hud.touch .bz-score .clock { font-size: 18px; }
.bz-hud.touch .bz-feed { top: 50px; }
.bz-hud.touch .bz-carry { bottom: 20px; }
.bz-screen button.bz-bots.small { margin-top: 12px; font-size: 13px; padding: 6px 14px; background: #3a4458; color: #fff; }
.bz-softinfo { margin-top: 10px; font-size: 12px; opacity: .7; }
.bz-screen button.bz-online.small { margin-top: 12px; font-size: 13px; padding: 6px 14px; background: #2f6f4f; color: #fff; }
.bz-roominfo { margin-top: 10px; font-size: 13px; opacity: .85; }
.bz-roominfo:empty { display: none; }
.bz-roominfo .red { color: #ff7a6a; } .bz-roominfo .blue { color: #7ab0ff; } .bz-roominfo a { color: #ffd060; }
.bz-net { position: absolute; right: 10px; top: 44px; font: 600 12px system-ui, sans-serif; padding: 4px 9px; border-radius: 7px; background: rgba(16,20,28,.55); color: #fff; }
.bz-net:empty { display: none; }
.bz-net.bad { background: rgba(160,40,30,.75); }
.bz-names { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.bz-name { position: absolute; left: 0; top: 0; font: 700 12px system-ui, sans-serif; padding: 1px 6px; border-radius: 4px; background: rgba(0,0,0,.45); white-space: nowrap; }
.bz-name.red { color: #ff8a7a; } .bz-name.blue { color: #8ab8ff; }
.bz-bots.corner { position: absolute; right: 10px; top: 10px; pointer-events: auto; font: 700 12px system-ui, sans-serif; padding: 5px 9px; border-radius: 7px; border: 0; background: rgba(16,20,28,.6); color: #fff; cursor: pointer; }
.bz-hud:not(.touch) .bz-bots.corner { display: none; }
.bz-hud.touch .bz-feed { top: 44px; }
@media (max-width: 640px) { .bz-score .team .lbl { display: none; } }
`;
