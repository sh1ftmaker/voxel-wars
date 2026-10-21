/**
 * Picks the transport from the URL and connects (src/net/Net.js):
 *   (default)                 single player: LocalTransport, edits apply synchronously
 *   ?room=name                online: the room `name` on the room server (PartyTransport; ?server=wss://host to use
 *                             another server, e.g. ?server=ws://127.0.0.1:8787 for `wrangler dev` in server/)
 *   ?room=name&local=1        tabs of this browser form a room over a BroadcastChannel (the first tab hosts)
 *   ?loopback=latency,jitter  single player through an in-page fake server (ms), to test the networked path
 *   ?snapEvery=s              the host's snapshot interval (tests; default 30 s)
 */
import { Net } from './Net.js';
import { LocalTransport, LoopbackServer, BroadcastChannelTransport, PartyTransport, DEFAULT_SERVER } from './transports.js';

export async function createNet(params, terrain) {
    let transport;
    const room = params.get('room');
    if(room && params.get('local') === '1') transport = new BroadcastChannelTransport(room);
    else if(room) transport = new PartyTransport(room, params.get('server') || DEFAULT_SERVER);
    else if(params.has('loopback')) {
        const [latency = 60, jitter = 20] = (params.get('loopback') || '').split(',').filter(Boolean).map(Number);
        transport = new LoopbackServer({ latency, jitter }).client();
    } else transport = new LocalTransport();
    const net = new Net({ transport, terrain, snapEvery: +params.get('snapEvery') || undefined }); // ?snapEvery=s (tests)
    net.room = room || null;
    await net.connect();
    if(!net.single) console.log(`net: ${transport.kind} ${room ? `room "${room}" ` : ''}as ${net.id}${net.isHost ? ' (host)' : ''}`);
    return net;
}
