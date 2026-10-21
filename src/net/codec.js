/**
 * Wire codec for net messages (src/net): any JSON-shaped message whose leaves may be typed arrays, as one
 * Uint8Array. Numbers travel as JSON (shortest round-trip form, so doubles such as brush specs arrive bit-exact);
 * typed arrays travel as raw bytes after the JSON. Messages over DEFLATE_MIN bytes are deflated (fflate).
 *
 *   bytes = encode(msg)        msg = decode(bytes)        (decode copies: the arrays it returns own their buffers)
 *
 * Layout: 'V' 'W' | version u8 | flags u8 (1 = deflated body) | body
 *         body = jsonLength u32 LE | JSON utf8 | blobs (each typed array's bytes, in order, 8-byte aligned)
 * A typed array in the JSON is replaced by { "$b": blobIndex, "$t": type, "$n": length }.
 * Bump VERSION when the layout or any message's meaning changes; decode rejects other versions.
 *
 * Also: fnv1a(bytes, h) (FNV-1a 32-bit, chained) for chunk hashes, deflate / inflate for snapshots.
 */
import { deflateSync, inflateSync } from 'three/examples/jsm/libs/fflate.module.js';

export const VERSION = 1;
const DEFLATE_MIN = 1024;
const TYPES = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array };
const te = new TextEncoder(), td = new TextDecoder();

export function encode(msg) {
    const blobs = [];
    const json = JSON.stringify(msg, function(k, v) {
        if(ArrayBuffer.isView(v) && !(v instanceof DataView)) { blobs.push(v); return { $b: blobs.length - 1, $t: v.constructor.name, $n: v.length }; }
        return v;
    });
    const j = te.encode(json);
    let size = 4 + j.length;
    const offs = [];
    for(const b of blobs) { size = (size + 7) & ~7; offs.push(size); size += b.byteLength; }
    const body = new Uint8Array(size);
    new DataView(body.buffer).setUint32(0, j.length, true);
    body.set(j, 4);
    blobs.forEach((b, i) => body.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), offs[i]));
    const packed = size > DEFLATE_MIN ? deflateSync(body, { level: 1 }) : null;
    const use = packed && packed.length < size ? packed : body;
    const out = new Uint8Array(4 + use.length);
    out[0] = 86; out[1] = 87; out[2] = VERSION; out[3] = use === body ? 0 : 1;
    out.set(use, 4);
    return out;
}

export function decode(bytes) {
    if(!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if(bytes[0] !== 86 || bytes[1] !== 87) throw new Error('net codec: not a message');
    if(bytes[2] !== VERSION) throw new Error(`net codec: version ${bytes[2]}, expected ${VERSION}`);
    let body = bytes.subarray(4);
    if(bytes[3] & 1) body = inflateSync(body);
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const jl = dv.getUint32(0, true);
    const json = td.decode(body.subarray(4, 4 + jl));
    let off = 4 + jl;
    return JSON.parse(json, function(k, v) {
        if(v && typeof v === 'object' && v.$t !== undefined && v.$b !== undefined) {
            const T = TYPES[v.$t];
            if(!T) throw new Error(`net codec: type ${v.$t}`);
            off = (off + 7) & ~7;
            const n = v.$n * T.BYTES_PER_ELEMENT;
            const a = new T(body.slice(off, off + n).buffer); // a copy, aligned
            off += n;
            return a;
        }
        return v;
    });
}

/** FNV-1a 32-bit over a byte view, continuing from h. */
export function fnv1a(bytes, h = 0x811c9dc5) {
    for(let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
    return h >>> 0;
}

export const deflate = (u8) => deflateSync(u8, { level: 6 });
export const inflate = (u8) => inflateSync(u8);
