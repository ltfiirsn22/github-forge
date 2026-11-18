// gitwire.ts — pkt-line encoder/decoder + sideband helpers (shared by gitd.ts)
// Rules: pkt length INCLUDES its own 4 bytes; flush 0000, delim 0001.

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

/** Encode one pkt-line from a payload (LF included in payload as given). */
export function pktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const len = data.length + 4;
  if (len > 65520) throw new Error(`pkt too long: ${len}`);
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), data]);
}

export function encodePackets(lines: Array<string | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(FLUSH);
    else if (line === 'delim') parts.push(DELIM);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'eof' };

/** Incremental pkt-line decoder over chunked bytes. */
export class PktDecoder {
  private buf = Buffer.alloc(0);

  push(chunk: Uint8Array): Packet[] {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
    const out: Packet[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const hex = this.buf.subarray(0, 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length prefix ${JSON.stringify(hex)}`);
      const len = parseInt(hex, 16);
      if (len === 0) { out.push({ kind: 'flush' }); this.buf = this.buf.subarray(4); continue; }
      if (len === 1) { out.push({ kind: 'delim' }); this.buf = this.buf.subarray(4); continue; }
      if (len < 4) throw new Error(`bad pkt-line length ${len}`);
      if (this.buf.length < len) break;
      out.push({ kind: 'data', payload: Buffer.from(this.buf.subarray(4, len)) });
      this.buf = this.buf.subarray(len);
    }
    return out;
  }

  /** Flush a trailing partial packet (error when bytes remain). */
  finish(): Packet[] {
    if (this.buf.length > 0) throw new Error(`trailing bytes after pkt stream: ${this.buf.length}`);
    return [];
  }
}

/** Decode a whole buffer at once. */
export function decodePackets(bytes: Uint8Array): Packet[] {
  const d = new PktDecoder();
  const out = d.push(bytes);
  out.push(...d.finish());
  return out;
}

/** Sideband-64k writer: chunks bytes into band-1 packets of at most 65515. */
export function sideband1(data: Uint8Array): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < data.length; off += CHUNK) {
    const slice = data.subarray(off, Math.min(off + CHUNK, data.length));
    const head = Buffer.alloc(1); head[0] = 1;
    parts.push(pktLine(Buffer.concat([head, slice])));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}
