/**
 * Picks the transport from the URL and connects (src/net/Net.js):
 *   (default)                 single player: LocalTransport, edits apply synchronously
 *   ?room=name                tabs of this browser form a room over a BroadcastChannel (the first tab hosts)
 *   ?loopback=latency,jitter  single player through an in-page fake server (ms), to test the networked path
 */
import { Net } from './Net.js';
import { LocalTransport, LoopbackServer, BroadcastChannelTransport } from './transports.js';

export async function createNet(params, terrain) {
    let transport;
    const room = params.get('room');
    if(room) transport = new BroadcastChannelTransport(room);
    else if(params.has('loopback')) {
        const [latency = 60, jitter = 20] = (params.get('loopback') || '').split(',').filter(Boolean).map(Number);
        transport = new LoopbackServer({ latency, jitter }).client();
    } else transport = new LocalTransport();
    const net = new Net({ transport, terrain });
    await net.connect();
    if(!net.single) console.log(`net: ${transport.constructor.name} ${room ? `room "${room}" ` : ''}as ${net.id}${net.isHost ? ' (host)' : ''}`);
    return net;
}
