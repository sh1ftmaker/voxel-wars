# Voxel Wars

Fort War ("Undermine") rebuilt on destructible voxel terrain, in the spirit of Donkey Kong Bananza: a sparse signed
distance voxel world (0.25 m), Surface Nets / dual contouring meshing in workers, box3d physics (wasm) with detached
terrain chunks that fall, shatter and settle back into diggable terrain.

Play: https://sh1ftmaker.github.io/voxel-wars/

```
npm install
npm run dev      # http://localhost:5180
```

## Play online

On the title card, **Play online** opens a new room and puts its invite link on the clipboard; send it to your
friends. Or open `https://sh1ftmaker.github.io/voxel-wars/?room=<any name>` yourself (add `&name=<you>` to pick a
name). The first player in a room hosts: bots run on their machine, and the host keeps health, crates, the score and
the clock. If the host leaves, the next player takes over. Players are put on the team with fewer people; bots fill
both teams (the host's Bots toggle).

The rooms run on a small Cloudflare Worker (`server/`, PartyServer + Durable Objects). To run your own:

```
cd server
npm install
npx wrangler deploy                 # prints https://voxel-wars.<your subdomain>.workers.dev
```

then point the game at it with `?server=wss://voxel-wars.<your subdomain>.workers.dev` (or change `DEFAULT_SERVER` in
`src/net/transports.js`). Locally: `npx wrangler dev --port 8787` in `server/` and `?room=test&server=ws://127.0.0.1:8787`.
`?room=test&local=1` makes a room of browser tabs without any server. Test: `node tools/test/mp.mjs` (three players,
each in its own headless browser; `node tools/test/mp.mjs <page url> deployed` goes through the deployed server).

See `docs/ARCHITECTURE.md`. `?mpm=1` turns on the granular ground (sand, snow and dirt that pour and slump when
blasted or undercut; `docs/MPM.md`). The Twin Forts level, textures (Poly Haven, CC0) and game design come from
[WorldParty](https://github.com/zalo/WorldParty) (MIT).
