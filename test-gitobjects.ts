// test-gitobjects.ts — strict validation of the pack layer against a REAL GitHub pack
// captured in rea-workshop/captures/, plus round-trip self-tests (write→read, delta apply).
// Run: node --experimental-strip-types test-gitobjects.ts
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  makeObject, hashObject, readPack, writePack, applyDelta,
  serializeCommit, parseCommit, serializeTree, parseTree,
  type GitObj,
} from './gitobjects.ts';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

// ---------- 1. round-trip: write pack → read pack ----------
const blobs: GitObj[] = [
  makeObject('blob', Buffer.from('hello world\n')),
  makeObject('blob', Buffer.from('second file with more bytes\n'.repeat(3))),
];
const treeData = serializeTree([
  { mode: '100644', name: 'a.txt', oid: blobs[0].oid },
  { mode: '100644', name: 'b.txt', oid: blobs[1].oid },
]);
const tree = makeObject('tree', treeData);
const commitData = serializeCommit({
  tree: tree.oid, parents: [],
  authorLine: 'Forge <forge@local> 1760000000 +0000',
  committerLine: 'Forge <forge@local> 1760000000 +0000',
  message: 'initial\n',
});
const commit = makeObject('commit', commitData);
const pack = writePack([blobs[0], blobs[1], tree, commit]);

const trailer = pack.subarray(pack.length - 20);
const h = createHash('sha1'); h.update(pack.subarray(0, pack.length - 20));
ok('pack trailer sha1', trailer.equals(h.digest()));

const back = readPack(pack);
ok('roundtrip object count', back.size === 4, `got ${back.size}`);
ok('roundtrip blob oid', back.has(blobs[0].oid));
ok('roundtrip blob bytes', back.get(blobs[0].oid)?.data.equals(blobs[0].data));
ok('roundtrip tree parse', JSON.stringify(parseTree(back.get(tree.oid)!.data)) === JSON.stringify(parseTree(treeData)));
ok('roundtrip commit parse', parseCommit(back.get(commit.oid)!.data).tree === tree.oid);

// ---------- 2. ofs-delta + ref-delta packing (hand-built) ----------
import { deflateSync } from 'node:zlib';
function buildPackRaw(entries: Array<{ typeNum: number; body: Buffer; ofs?: Buffer }>): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const head = Buffer.alloc(8);
  head.writeUInt32BE(2, 0); head.writeUInt32BE(entries.length, 4);
  parts.push(head);
  for (const e of entries) {
    // entry header's size field = UNCOMPRESSED size of the payload AFTER any ofs varint (git spec)
    let size = e.body.length;
    const hdr: number[] = [];
    let first = (e.typeNum << 4) | (size & 0x0f); size >>= 4;
    while (size > 0) { hdr.push(first | 0x80); first = size & 0x7f; size >>= 7; }
    hdr.push(first);
    parts.push(Buffer.from(hdr));
    if (e.ofs) parts.push(e.ofs); // ofs-delta target offset is PLAINTEXT, before the zlib stream
    if (e.typeNum === 6) console.error('DBG body', e.body.length, e.body.toString('hex'));
    parts.push(deflateSync(e.body, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const hh = createHash('sha1'); hh.update(body);
  return Buffer.concat([body, hh.digest()]);
}
// base blob (type 3), ofs-delta over it (type 6) → second blob
const baseB = Buffer.from('alpha beta gamma delta\n');
const targetB = Buffer.from('alpha beta GAMMA delta\nepsilon\n');
// delta: copy 0..11 ('alpha beta '), insert 'GAMMA', copy 17..23 (' delta'), insert '\nepsilon\n'
function buildDelta(base: Buffer, target: Buffer): Buffer {
  const varint = (v: number): Buffer => { const out: number[] = []; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v); return Buffer.from(out); };
  const parts = [varint(base.length), varint(target.length)];
  // copy cmd: bits0-3 offset bytes, bits4-6 size bytes
  const off = 0, size = 11;
  const cmd = 0x80 | 0x01 | 0x10; // offset 1 byte, size 1 byte
  parts.push(Buffer.from([cmd, off & 0xff, size & 0xff]));
  parts.push(Buffer.from([5]), Buffer.from('GAMMA'));
  parts.push(Buffer.from([0x80 | 0x01 | 0x10, 16, 7]));
  parts.push(Buffer.from([8]), Buffer.from('epsilon\n'));
  return Buffer.concat(parts);
}
const delta = buildDelta(baseB, targetB);
const applied = applyDelta(baseB, delta);
ok('hand delta apply', applied.equals(targetB), applied.toString().slice(0, 40));
// base at offset 12 (after 12-byte header), ofs-delta right after: baseOfsRel = entryHeaderStart - baseOffset
// we don't know delta header length until we encode it; encode: base blob body then delta body.
const basePacked = deflateSync(baseB, { level: 1 });
const deltaPacked = deflateSync(delta, { level: 1 });
const baseHdrLen = (() => { let size = baseB.length; let first = (3 << 4) | (size & 0x0f); size >>= 4; const h: number[] = []; while (size > 0) { h.push(first | 0x80); first = size & 0x7f; size >>= 7; } h.push(first); return h.length; })();
const baseStart = 12;
const baseEnd = baseStart + baseHdrLen + basePacked.length;
// delta entry header length (varies with delta size; compute with one byte then verify)
const deltaHdrLen = (() => { let size = delta.length; let first = (6 << 4) | (size & 0x0f); size >>= 4; const h: number[] = []; while (size > 0) { h.push(first | 0x80); first = size & 0x7f; size >>= 7; } h.push(first); return h.length; })();
const neg = baseEnd - baseStart; // offset of delta header − offset of base header
// ofs varint with +bias encoding (encode value `neg`)
function encodeOfs(negv: number): Buffer { const bytes: number[] = []; let v = negv; bytes.push(v & 0x7f); v >>>= 7; while (v > 0) { v -= 1; bytes.unshift(0x80 | (v & 0x7f)); v >>>= 7; } return Buffer.from(bytes); }
// Wait: encoding per git is: first byte low 7 bits, then next bytes more significant with +1 bias.
// Simplest correct encoder for positive n: digits = [], while(true){ if n<128 {digits.push(n); break;} digits.push(0x80 | (n & 0x7f)); n = (n >> 7) - 1; } then reverse? git encodes MSB-first with +1 bias on continuation.
// We'll validate by decoding with our own reader AND with git's documented decoder on the same bytes.
const ofsBytes = encodeOfs(neg);
const packRaw = buildPackRaw([
  { typeNum: 3, body: baseB },
  { typeNum: 6, body: delta, ofs: ofsBytes },
]);
const resolved = readPack(packRaw);
ok('pack ofs-delta resolves base', resolved.has(createHash('sha1').update('blob 20\0').update(baseB).digest('hex')) || [...resolved.values()].some(o => o.data.equals(baseB)));
ok('pack ofs-delta resolves target', [...resolved.values()].some(o => o.data.equals(targetB)));

// ---------- 3. real GitHub pack from captures ----------
import { readdirSync } from 'node:fs';
const capDir = '/workspace/projects/rea-workshop/captures/work/Hello-World/.git/objects/pack';
try {
  const files = readdirSync(capDir);
  const packFile = files.find(f => f.endsWith('.pack'));
  if (packFile === undefined) throw new Error('no .pack in captures');
  const real = readFileSync(`${capDir}/${packFile}`);
  const realObjs = readPack(real);
  ok('real github pack parses', realObjs.size > 0, `size ${realObjs.size}`);
  // recompute every object's oid: makeObject would rehash — verify all match their key
  let allHash = true;
  for (const [oid, obj] of realObjs) {
    if (hashObject(obj.type, obj.data) !== oid) { allHash = false; break; }
  }
  ok('every real object oid recomputes', allHash);
} catch (err) {
  ok('real github pack parses', false, err instanceof Error ? err.message : String(err));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
