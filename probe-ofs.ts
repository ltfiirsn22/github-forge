// probe-ofs.ts — run the library's scanPack on the test's ofs pack, dump per-entry walk.
import { scanPack } from './gitobjects.ts';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const baseB = Buffer.from('alpha beta gamma delta\n');
const varint = (v: number): Buffer => { const out: number[] = []; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v); return Buffer.from(out); };
const delta = Buffer.concat([
  varint(22), varint(31),
  Buffer.from([0x91, 0, 11]),
  Buffer.from([5]), Buffer.from('GAMMA'),
  Buffer.from([0x91, 16, 7]),
  Buffer.from([8]), Buffer.from('epsilon\n'),
]);
const neg = 33;
const ofsBytes = ((): Buffer => { const bytes: number[] = []; let v = neg; bytes.push(v & 0x7f); v >>>= 7; while (v > 0) { v -= 1; bytes.unshift(0x80 | (v & 0x7f)); v >>>= 7; } return Buffer.from(bytes); })();
const deltaEntry = Buffer.concat([ofsBytes, delta]);
function buildPackRaw(entries: Array<{ typeNum: number; body: Buffer }>): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const head = Buffer.alloc(8); head.writeUInt32BE(2, 0); head.writeUInt32BE(entries.length, 4); parts.push(head);
  for (const e of entries) {
    let size = e.body.length; const hdr: number[] = [];
    let first = (e.typeNum << 4) | (size & 0x0f); size >>= 4;
    while (size > 0) { hdr.push(first | 0x80); first = size & 0x7f; size >>= 7; }
    hdr.push(first);
    parts.push(Buffer.from(hdr)); parts.push(deflateSync(e.body, { level: 1 }));
  }
  const body = Buffer.concat(parts); const h = createHash('sha1'); h.update(body);
  return Buffer.concat([body, h.digest()]);
}
const packRaw = buildPackRaw([{ typeNum: 3, body: baseB }, { typeNum: 6, body: deltaEntry }]);
console.log('pack', packRaw.length, 'deltaEntry', deltaEntry.length);
console.log('hex', packRaw.toString('hex'));
try {
  const s = scanPack(packRaw);
  console.log('scanPack OK', s.entries.map(e => ({ t: e.type, off: e.offset, d: e.dataOffset, size: e.size, rel: e.baseOfsRel })));
} catch (err) {
  console.log('scanPack ERR', err instanceof Error ? err.message : err);
}
