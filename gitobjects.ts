// gitobjects.ts — git object model: loose objects, SHA-1 oid, packfile read/write, delta apply.
// Stdlib only: node:crypto (sha1), node:zlib (inflate/deflate).

import { createHash, type Hash } from 'node:crypto';
import { inflateSync, inflate, deflateSync, constants as zlibConstants } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export interface GitObj { type: ObjType; data: Buffer; oid: string; }

/** oid = sha1("<type> <size>\0<content>") */
export function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`);
  h.update(data);
  return h.digest('hex');
}

export function makeObject(type: ObjType, data: Buffer): GitObj {
  return { type, data: Buffer.from(data), oid: hashObject(type, data) };
}

/** Parse a raw commit; headers end at the first blank line. */
export function parseCommit(data: Buffer): { tree: string; parents: string[]; author: string; committer: string; message: string } {
  const text = data.toString('utf8');
  const end = text.indexOf('\n\n');
  const head = end === -1 ? text : text.slice(0, end);
  const message = end === -1 ? '' : text.slice(end + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Serialize a commit. */
export function serializeCommit(c: { tree: string; parents: readonly string[]; authorLine: string; committerLine: string; message: string }): Buffer {
  const lines: string[] = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.authorLine}`);
  lines.push(`committer ${c.committerLine}`);
  return Buffer.from(`${lines.join('\n')}\n\n${c.message}`);
}

export interface TreeEnt { mode: string; name: string; oid: string; }

/** Parse a raw tree into entries. */
export function parseTree(data: Buffer): TreeEnt[] {
  const out: TreeEnt[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0, sp + 1);
    const mode = data.subarray(i, sp).toString('ascii');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}

/** Serialize entries (mode as given: directories '40000'). */
export function serializeTree(entries: readonly TreeEnt[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ packfile format

interface PackEntry {
  type: number; // 1..7
  offset: number; // offset of the entry header in the pack
  dataOffset: number; // where the zlib stream starts
  size: number; // uncompressed size
  baseRef?: string; // type 7: 20-byte base oid (hex)
  baseOfsRel?: number; // type 6: negative offset from this entry's header
}

/** Sanity-check a would-be pack entry header at `off`: plausible type + declared size. */
function headerLooksSane(pack: Buffer, off: number): boolean {
  if (off >= pack.length) return false;
  const byte = pack[off];
  const type = (byte >> 4) & 7;
  if (type < 1 || type > 7) return false;
  let size = byte & 0x0f;
  let shift = 4;
  let cur = off;
  let b = byte;
  while (b & 0x80) {
    if (++cur >= pack.length) return true; // end of buffer: can't falsify further
    b = pack[cur];
    size |= (b & 0x7f) << shift;
    shift += 7;
  }
  if (size > pack.length) return false; // declared data bigger than the whole pack: bogus
  return true;
}

/** Walk a pack's entry table (offsets + inflated sizes), tolerant of zlib end-of-stream ambiguity. */
function packEntries(pack: Buffer): PackEntry[] {
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`bad pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const entries: PackEntry[] = [];
  let off = 12;
  for (let n = 0; n < count; n++) {
    const start = off;
    let byte = pack[off++];
    const type = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[off++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const entry: PackEntry = { type, offset: start, dataOffset: off, size };
    if (type === 6) {
      // ofs-delta: offset varint (PLAINTEXT, before the zlib stream) with the +bias encoding
      byte = pack[off++];
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[off++];
        value = ((value + 1) << 7) | (byte & 0x7f);
      }
      entry.baseOfsRel = value;
    } else if (type === 7) {
      entry.baseRef = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    entry.dataOffset = off; // after any ofs/ref header bytes — the zlib stream starts here
    // Find the stream end: inflate prefixes until output reaches the declared size. Some zlib builds
    // report success one byte LATE (they need a trailing byte to confirm end-of-stream), so when the
    // next header parses insane, backtrack one byte.
    let consumed = -1;
    let data: Buffer | null = null;
    for (let k = 2; k <= pack.length - off; k++) {
      try {
        const out = inflateSync(pack.subarray(off, off + k));
        if (out.length === size) { consumed = k; data = out; break; }
        if (out.length > size) throw new Error(`inflated ${out.length} > declared ${size}`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('inflated')) throw err;
        continue;
      }
    }
    if (consumed === -1) {
      throw new Error(`truncated zlib stream in pack entry ${n} (dataStart ${off}, type ${type}, declaredSize ${size}, remaining ${pack.length - off})`);
    }
    // zlib quirk: some builds report success one byte PAST the true stream end (they need a trailing
    // byte to confirm end-of-stream). When the next header parses insane, retry one byte shorter with
    // Z_SYNC_FLUSH (which tolerates the missing confirming byte) — if it still yields the declared
    // size and the header there looks sane, that one byte belonged to the next entry.
    if (consumed >= 3 && !headerLooksSane(pack, off + consumed)) {
      try {
        const shorter = inflateSync(pack.subarray(off, off + consumed - 1), { finishFlush: zlibConstants.Z_SYNC_FLUSH });
        if (shorter.length === size && headerLooksSane(pack, off + consumed - 1)) {
          consumed -= 1;
          data = shorter;
        }
      } catch { /* keep original */ }
    }
    entry.size = data!.length;
    off += consumed;
    entries.push(entry);
  }
  return entries;
}

/** Read a pack's object table without resolving deltas (validation helper). */
export function scanPack(pack: Buffer): { entries: PackEntry[]; count: number } {
  return { entries: packEntries(pack), count: pack.readUInt32BE(8) };
}

/** Fully resolve one pack into objects (deltas applied). */
export function readPack(pack: Buffer, external?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const entries = packEntries(pack);
  const out = new Map<string, GitObj>();
  const byOffset = new Map<number, { type: number; data: Buffer }>();

  const inflateAt = (e: PackEntry): Buffer => inflateSync(pack.subarray(e.dataOffset)) as Buffer;
  const typeName = (t: number): ObjType => {
    if (t === 1) return 'commit';
    if (t === 2) return 'tree';
    if (t === 3) return 'blob';
    if (t === 4) return 'tag';
    throw new Error(`bad object type ${t}`);
  };

  const resolve = (idx: number, depth = 0): { type: number; data: Buffer } => {
    const e = entries[idx];
    const cached = byOffset.get(e.offset);
    if (cached) return cached;
    if (depth > 64) throw new Error('delta chain too deep');
    let type = e.type;
    let data: Buffer;
    if (type === 6) {
      const baseOffset = e.offset - e.baseOfsRel!;
      const baseIdx = entries.findIndex(x => x.offset === baseOffset);
      if (baseIdx < 0) throw new Error(`ofs-delta base offset ${baseOffset} not found`);
      const base = resolve(baseIdx, depth + 1);
      data = applyDelta(base.data, inflateAt(e));
      type = base.type;
    } else if (type === 7) {
      const baseOid = e.baseRef!;
      const fromPack = [...out.entries()].find(([oid]) => oid === baseOid);
      let base: { type: number; data: Buffer } | undefined;
      if (fromPack !== undefined) base = { type: TYPE_NUM[fromPack[1].type], data: fromPack[1].data };
      else {
        const ext = external?.(baseOid);
        if (ext === undefined) throw new Error(`ref-delta base ${baseOid} not found`);
        base = { type: TYPE_NUM[ext.type], data: ext.data };
      }
      data = applyDelta(base.data, inflateAt(e));
      type = base.type;
    } else {
      data = inflateAt(e);
    }
    byOffset.set(e.offset, { type, data });
    const obj = makeObject(typeName(type), data);
    out.set(obj.oid, obj);
    return { type, data };
  };

  for (let i = 0; i < count; i++) resolve(i);
  return out;
}

/** Apply a git delta buffer to a base. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readVar = (): number => {
    let v = 0; let shift = 0;
    for (;;) {
      const b = delta[p++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v >>> 0;
  };
  const baseSize = readVar();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} != ${base.length}`);
  const targetSize = readVar();
  const parts: Buffer[] = [];
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      // copy
      let offset = 0, size = 0;
      if (op & 0x01) offset |= delta[p++] << 0;
      if (op & 0x02) offset |= delta[p++] << 8;
      if (op & 0x04) offset |= delta[p++] << 16;
      if (op & 0x08) offset |= delta[p++] << 24;
      if (op & 0x10) size |= delta[p++] << 0;
      if (op & 0x20) size |= delta[p++] << 8;
      if (op & 0x40) size |= delta[p++] << 16;
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
    } else {
      if (op === 0) throw new Error('delta op 0x00 is invalid');
      parts.push(delta.subarray(p, p + op));
      p += op;
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize) throw new Error(`delta target size ${targetSize} != ${out.length}`);
  return out;
}

/** Write a pack (v2, full objects, no deltas — always protocol-legal). */
export function writePack(objects: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const head = Buffer.alloc(8);
  head.writeUInt32BE(2, 0);
  head.writeUInt32BE(objects.length, 4);
  parts.push(head);
  for (const obj of objects) {
    const type = TYPE_NUM[obj.type];
    let size = obj.data.length;
    let first = (type << 4) | (size & 0x0f);
    size >>= 4;
    let hdr: number[] = [];
    while (size > 0) {
      hdr.push(first | 0x80);
      first = size & 0x7f;
      size >>= 7;
    }
    hdr.push(first);
    parts.push(Buffer.from(hdr));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const h = createHash('sha1'); h.update(body);
  return Buffer.concat([body, h.digest()]);
}
