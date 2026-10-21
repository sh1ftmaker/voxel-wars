/** Tool and weapon numbers. Started from WorldParty's rules.js (src/game/rules.js) and tuned for a single-player demo.
 *  Radii and speeds in metres; blast damage falls off linearly to zero at 1.6 radii. */
export const WEAPONS = {
    punch:   { name: 'Punch',          icon: '👊', cooldown: 0.28, reach: 3.0, radius: 1.05, damage: 34, knock: 13, propSpeed: 16 },
    grab:    { name: 'Grab & Throw',   icon: '✊', cooldown: 0.35, reach: 4.2, radius: 0.95, throwSpeed: 36, shatterSpeed: 13, blast: 1.7, damage: 65, knock: 16 },
    rocket:  { name: 'Rocket',         icon: '🚀', cooldown: 0.9,  speed: 46, gravity: 10, radius: 2.4, damage: 70, direct: 40, knock: 18, life: 6 },
    grenade: { name: 'Grenade',        icon: '💣', cooldown: 0.9,  minSpeed: 9, maxSpeed: 27, charge: 1.3, fuse: 2.6, radius: 3.2, damage: 85, knock: 22 },
    drill:   { name: 'Drill',          icon: '⛏️', cooldown: 0.36, radius: 1.6, reach: 1.3, sink: 0.1 },
    mason:   { name: 'Mason',          icon: '🧱', cooldown: 0.3,  budget: 40, regen: 4, digYield: 0.3, maxDistance: 9 },
    buster:  { name: 'Bunker Buster',  icon: '☢️', cooldown: 2.0,  speed: 13, fuse: 4.2, radius: 5.6, damage: 150, knock: 30, perLife: 1 },
};
/** Toolbar order (number keys 1..7). */
export const TOOLS = ['punch', 'grab', 'rocket', 'grenade', 'drill', 'mason', 'buster'];
export const SELF_DAMAGE_SCALE = 0.4;   // rocket jumping hurts, a little
export const BOT_DAMAGE_SCALE = 0.45;   // bots hit softer than you do
/** Mason shapes: a wall across the view, or a block. Sizes in metres (x across, y up, z along the view). */
export const MASON_SHAPES = [
    { name: 'Wall', size: [4, 3, 1] },
    { name: 'Block', size: [2, 2, 2] },
    { name: 'Floor', size: [3, 0.5, 3] },
];
