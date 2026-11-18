// gitd.ts — git smart-HTTP surface: info/refs advertisement (v2 upload-pack, v0 both),
// v2 ls-refs/fetch, v0 fetch, receive-pack (push) with report-status + side-band-64k.
// Store: repo.commits (sha -> CommitNode with tree path->blobId), repo.tags (name -> tag oid),
// blobs in the REST blob map (store.ts repoBlobs lives in rest.ts; re-exported here via findBlob).

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import { encodePackets, sideband1, PktDecoder } from './gitwire.ts';
import {
  makeObject, readPack, writePack, applyDelta,
  parseCommit, serializeCommit, parseTree, serializeTree,
  TYPE_NUM, type GitObj, type ObjType,
} from './gitobjects.ts';
import { store, getRepoAnyOwner, LC, type Repo, type Json } from './store.ts';

const FLUSH = Buffer.from('0000', 'ascii');

export interface GitCtx {
  owner: string;
  repoName: string; // without .git
  method: string;
  path: string; // /{owner}/{repo}.git/...
  query: URLSearchParams;
  protocolV2: boolean; // Git-Protocol: version=2 header
  body: Buffer;
  res: import('node:http').ServerResponse;
}

// ---------- object storage bridge ----------
// The forge keeps blob bytes in a WeakMap per repo (rest.ts repoBlobs). For git we need:
// oid -> (type, data). Blobs: recompute from tree? We store blob bytes keyed by contentSha.
// Commit objects: stored as CommitNode in repo.commits — reconstruct raw commit bytes on demand.
// Trees: serialized from CommitNode.tree entries on demand.

declare module './store.ts' {
  interface Repo { tags: Map<string, string>; }
}
// store.ts Repo has no tags; add at runtime:
function tagsOf(repo: Repo): Map<string, string> {
  const anyRepo = repo as unknown as { tags?: Map<string, string> };
  if (!anyRepo.tags) anyRepo.tags = new Map();
  return anyRepo.tags;
}

function tagObjects(repo: Repo): Map<string, GitObj> {
  const anyRepo = repo as unknown as { tagObjects?: Map<string, GitObj> };
  if (!anyRepo.tagObjects) anyRepo.tagObjects = new Map();
  return anyRepo.tagObjects;
}

interface BlobStore { get(blobSha: string): string | undefined; set(blobSha: string, content: string): void; }
const blobMaps = new WeakMap<Repo, BlobStore>();
export function registerBlobStore(repo: Repo, s: BlobStore): void { blobMaps.set(repo, s); }
function blobs(repo: Repo): BlobStore {
  let m = blobMaps.get(repo);
  if (!m) {
    // real backing map: a stub with no-op set would silently swallow every stored blob
    const backing = new Map<string, string>();
    m = { get: (k) => backing.get(k), set: (k, v) => { backing.set(k, v); } };
    blobMaps.set(repo, m);
  }
  return m;
}

function commitRaw(repo: Repo, sha: string): Buffer | null {
  // Pushed commits keep their EXACT original bytes: re-serializing from parsed fields would change
  // the author line and thus the oid, and the client would see a different tip.
  const rawMap = (repo as unknown as { commitRaws?: Map<string, Buffer> }).commitRaws;
  const raw = rawMap?.get(sha);
  if (raw !== undefined) return raw;
  const c = repo.commits.get(sha);
  if (c === undefined) return null;
  return serializeCommit({ tree: c.tree, parents: c.parents, authorLine: `forge <forge@local> 1760000000 +0000`, committerLine: `forge <forge@local> 1760000000 +0000`, message: c.message });
}

function treeRaw(repo: Repo, sha: string): Buffer | null {
  const c = repo.commits.get(sha);
  if (c === undefined) return null;
  const entries: { mode: string; name: string; oid: string }[] = [];
  for (const [p, blobSha] of Object.entries(c.tree)) {
    const isDir = p.includes('/');
    // git trees hold one entry per segment level; we store flat paths — synthesize nested trees
    entries.push({ mode: isDir ? '40000' : '100644', name: p, oid: blobSha });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return serializeTree(entries);
}

// ---------- honest git objects for REST-created content ----------
// REST-created commits/blobs must carry REAL git oids (sha1 of content) so that git transport
// (clone/fetch/push) produces a verifiable graph: the client recomputes every object's sha.

/** Store blob content and return its honest git blob oid. */
export function honestBlob(repo: Repo, content: string): string {
  const obj = makeObject('blob', Buffer.from(content, 'utf8'));
  blobs(repo).set(obj.oid, content);
  if (process.env.FORGE_DEBUG) console.error(`DBG honestBlob store ${obj.oid} repo=${(repo as unknown as {name?: string}).name} mapSizeNow=${blobMaps.get(repo) ? 'yes' : 'no'}`);
  return obj.oid;
}

/** Create a commit with a REAL nested tree built from the flat path->blobOid map. Returns commit oid. */
export function honestCommit(
  repo: Repo,
  flatTree: Record<string, string>,
  parents: string[],
  message: string,
): string {
  // build nested tree: { name -> oid | subtree }
  type Node = { sub: Map<string, Node>; leaf?: string };
  const root: Node = { sub: new Map() };
  for (const [path, oid] of Object.entries(flatTree)) {
    const segs = path.split('/');
    let cur = root;
    for (let i = 0; i < segs.length - 1; i++) {
      let next = cur.sub.get(segs[i]);
      if (next === undefined || next.leaf !== undefined) {
        next = { sub: new Map() };
        cur.sub.set(segs[i], next);
      }
      cur = next;
    }
    cur.sub.set(segs[segs.length - 1], { sub: new Map(), leaf: oid });
  }
  const treeRaws = (repo as unknown as { treeRaws?: Map<string, Buffer> });
  if (!treeRaws.treeRaws) treeRaws.treeRaws = new Map();
  const raws = treeRaws.treeRaws as Map<string, Buffer>;
  const writeTree = (node: Node): string => {
    const entries = [...node.sub.entries()].map(([name, child]) =>
      child.leaf !== undefined
        ? { mode: '100644', name, oid: child.leaf }
        : { mode: '40000', name, oid: writeTree(child) },
    );
    entries.sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1));
    const raw = serializeTree(entries);
    const obj = makeObject('tree', raw);
    raws.set(obj.oid, raw);
    return obj.oid;
  };
  const rootOid = writeTree(root);
  const raw = serializeCommit({
    tree: rootOid,
    parents,
    authorLine: 'forge <forge@local> 1760000000 +0000',
    committerLine: 'forge <forge@local> 1760000000 +0000',
    message,
  });
  const obj = makeObject('commit', raw);
  const rawMap = (repo as unknown as { commitRaws?: Map<string, Buffer> });
  if (!rawMap.commitRaws) rawMap.commitRaws = new Map();
  rawMap.commitRaws.set(obj.oid, raw);
  repo.commits.set(obj.oid, { sha: obj.oid, message, tree: flatTree, parents, lc: LC() });
  return obj.oid;
}

/** Collect a commit + its raw tree + all blobs as GitObj list. Uses ORIGINAL pushed bytes. */
function objectsForCommit(repo: Repo, sha: string, out: Map<string, GitObj>, blobOf: (blobSha: string) => string | undefined): void {
  if (out.has(sha)) return;
  const raw = commitRaw(repo, sha);
  if (raw === null) return;
  const obj = makeObject('commit', raw);
  out.set(obj.oid, obj);
  const node = repo.commits.get(sha)!;
  // the tree the client expects is the one the push carried: raw tree bytes stored at absorb time
  const rawTrees = (repo as unknown as { treeRaws?: Map<string, Buffer> });
  if (!rawTrees.treeRaws) rawTrees.treeRaws = new Map();
  // walk the stored tree recursively, emitting tree objects with ORIGINAL bytes
  const emitTree = (entries: Array<{ mode: string; name: string; oid: string }>, raw?: Buffer): void => {
    const serialized = raw ?? serializeTree(entries);
    const t = makeObject('tree', serialized);
    out.set(t.oid, t);
    for (const ent of entries) {
      if (ent.mode === '40000' || ent.mode === '040000') {
        // nested subtree: emit its ORIGINAL bytes (stored at absorb time) and recurse
        const raw = rawTrees?.treeRaws?.get(ent.oid);
        if (raw === undefined) continue;
        const t = makeObject('tree', raw);
        out.set(t.oid, t);
        for (const sub of parseTree(raw)) emitTree([sub]);
      } else if (!out.has(ent.oid)) {
        const content = blobOf(ent.oid) ?? '';
        out.set(ent.oid, makeObject('blob', Buffer.from(content, 'utf8')));
      }
    }
  };
  // rebuild the entry list from the flat tree (paths with '/'), using raw subtree bytes when stored
  const buildEntries = (treeOid: string): Array<{ mode: string; name: string; oid: string }> => {
    const rawTree = rawTrees.treeRaws.get(treeOid);
    if (rawTree !== undefined) return parseTree(rawTree);
    const flat = Object.entries(node.tree);
    return flat.map(([p, oid]) => ({ mode: p.includes('/') ? '40000' : '100644', name: p, oid }));
  };
  const topTreeOid = parseCommit(raw).tree;
  emitTree(buildEntries(topTreeOid), rawTrees.treeRaws.get(topTreeOid));
}

/** Walk commit ancestry from a tip; stops at shallow boundaries. */
function walkCommits(repo: Repo, tip: string, shallow: Set<string>): string[] {
  const seen: string[] = [];
  const visited = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (visited.has(sha) || !repo.commits.has(sha)) continue;
    visited.add(sha);
    seen.push(sha);
    if (shallow.has(sha)) continue;
    const c = repo.commits.get(sha)!;
    for (const p of c.parents) if (!visited.has(p)) stack.push(p);
  }
  return seen;
}

// ---------- advertisement ----------

function refList(repo: Repo): Array<{ name: string; oid: string; peeled?: string; symref?: string }> {
  // cached per ref-generation; the generation bumps wherever packCache clears (every ref change)
  const gen = (repo as unknown as { refGen?: number; refGenCache?: Map<number, Array<{ name: string; oid: string; peeled?: string; symref?: string }>> });
  if (gen.refGen === undefined) gen.refGen = 0;
  if (gen.refGenCache === undefined) gen.refGenCache = new Map();
  const cached = gen.refGenCache.get(gen.refGen);
  if (cached !== undefined) return cached;
  const refs: Array<{ name: string; oid: string; peeled?: string; symref?: string }> = [];
  const headTarget = repo.defaultBranch;
  const headSha = repo.branches.get(headTarget) ?? null;
  if (headSha !== null) refs.push({ name: 'HEAD', oid: headSha, symref: `refs/heads/${headTarget}` });
  const names = [...repo.branches.keys()].sort();
  for (const n of names) refs.push({ name: `refs/heads/${n}`, oid: repo.branches.get(n)! });
  for (const [n, sha] of [...tagsOf(repo).entries()].sort()) {
    const peeled = peel(repo, sha);
    refs.push({ name: `refs/tags/${n}`, oid: sha, ...(peeled ? { peeled } : {}) });
  }
  if (gen.refGenCache.size < 16) gen.refGenCache.set(gen.refGen, refs);
  return refs;
}

function peel(repo: Repo, tagOid: string): string | null {
  // A tag object's 'object' header names its target; tags in this forge are lightweight (refs to
  // commits) or annotated (tag object stored in repo.commits? no — keep annotated tags in tagMap).
  const tagObj = tagObjects(repo).get(tagOid);
  if (tagObj !== undefined) {
    const text = tagObj.data.toString('utf8');
    const m = /^object ([0-9a-f]{40})/m.exec(text);
    return m ? m[1] : null;
  }
  return null; // lightweight tag: peels to itself (client checks only annotated round-trip)
}

const UPLOAD_PACK_V2_CAPS = [
  'agent=forge/1.0',
  'ls-refs=unborn',
  'fetch=shallow wait-for-done filter',
  'server-option',
  'object-format=sha1',
];

function pkt(s: string | Buffer): Buffer {
  const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0'), 'ascii'), b]);
}

function advertiseUploadPackV2(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    ...UPLOAD_PACK_V2_CAPS.map(c => pkt(`${c}\n`)),
    FLUSH,
  ]);
}

function advertiseV0(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo | null, hasHead: boolean): Buffer {
  const caps = service === 'git-upload-pack'
    ? 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done object-format=sha1 agent=forge/1.0'
    : 'report-status report-status-v2 delete-refs side-band-64k ofs-delta atomic object-format=sha1 quiet agent=forge/1.0';
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const refs = repo === null ? [] : refList(repo);
  if (refs.length === 0) {
    // unborn: capabilities^{} on zero-id (with symref cap for HEAD)
    parts.push(pkt(`0000000000000000000000000000000000000000 capabilities^{}\0${caps}${hasHead ? '' : ''}\n`));
  } else {
    refs.forEach((r, i) => {
      let line = `${r.oid} ${r.name}`;
      if (i === 0) {
        const extra: string[] = [caps];
        if (r.symref !== undefined) extra.unshift(`symref=HEAD:${r.symref}`);
        // peeled cap needed for peel advertisement
        extra.push('peel');
        line += `\0${extra.join(' ')}`;
      } else if (r.peeled !== undefined) {
        line += '';
      }
      parts.push(pkt(`${line}\n`));
      if (r.peeled !== undefined) parts.push(pkt(`${r.peeled} ${r.name}^{}\n`));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------- ls-refs ----------

function lsRefs(repo: Repo, args: string[]): Buffer {
  const symrefs = args.includes('symrefs');
  const peel = args.includes('peel');
  const prefixes: string[] = [];
  for (const a of args) {
    if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  for (const r of refList(repo)) {
    if (prefixes.length > 0 && !prefixes.some(p => r.name.startsWith(p))) {
      continue; // HEAD (named literally "HEAD") is sent only when a prefix matches it; git filters
                // by the ref NAME, not the symref target
    }
    let line = `${r.oid} ${r.name}`;
    if (symrefs && r.symref !== undefined) line += ` symref-target:${r.symref}`;
    if (peel && r.peeled !== undefined) line += ` peeled:${r.peeled}`;
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------- fetch (v2) ----------

function collectObjects(repo: Repo, tips: string[], haves: Set<string>, shallow: Set<string>, deepen: number | null): { objs: Map<string, GitObj>; shallow: string[]; unshallow: string[] } {
  const objs = new Map<string, GitObj>();
  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];
  // objects reachable from the client's haves are presumed already held by the client
  const heldObjects = new Set<string>();
  for (const have of haves) {
    if (!repo.commits.has(have)) continue;
    const haveObjs = new Map<string, GitObj>();
    objectsForCommit(repo, have, haveObjs, (blobSha) => blobs(repo).get(blobSha));
    for (const oid of haveObjs.keys()) heldObjects.add(oid);
  }
  const deliveredTags: GitObj[] = [];
  const tagByOid = new Map([...tagsOf(repo).entries()].map(([name, oid]) => [oid, name]));
  for (const tip of tips) {
    // tag tips: deliver the tag object itself plus the commit it points at
    const isTag = tagByOid.has(tip);
    const tagTarget = isTag ? tip : undefined;
    const tagObj = isTag ? tagObjects(repo).get(tip) : undefined;
    if (tagObj !== undefined) deliveredTags.push(tagObj);
    if (!repo.commits.has(tip) && tagObj === undefined) continue;
    // walk ancestry, bounded by the requested depth when given (levelsFromTip stops at maxDepth)
    const levels = repo.commits.has(tip)
      ? levelsFromTip(repo, tip, new Set(), deepen ?? Number.MAX_SAFE_INTEGER)
      : [[tagsOf(repo).get(tip)!, 1] as [string, number]];
    const maxDepth = deepen != null ? deepen : Number.MAX_SAFE_INTEGER;
    for (const [sha, depth] of levels) {
      if (depth > maxDepth) continue;
      if (haves.has(sha)) continue;
      objectsForCommit(repo, sha, objs, (blobSha) => blobs(repo).get(blobSha));
    }
    if (deepen != null) {
      // commits at exactly the requested depth are shallow boundaries
      for (const [sha, depth] of levels) {
        if (depth === deepen && !shallow.has(sha)) shallowLines.push(`shallow ${sha}\n`);
      }
    }
  }
  // drop everything the client already holds (reachable from its haves)
  for (const oid of heldObjects) objs.delete(oid);
  // a delivered tag tip must carry its tag object even if filtered above
  for (const t of deliveredTags) if (!heldObjects.has(t.oid)) objs.set(t.oid, t);
  return { objs, shallow: shallowLines, unshallow: unshallowLines };
}

function levelsFromTip(repo: Repo, tip: string, haves: Set<string>, maxDepth = 64): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const visited = new Set<string>();
  let frontier = [tip];
  let depth = 1;
  while (frontier.length > 0 && depth <= maxDepth) {
    const next: string[] = [];
    for (const sha of frontier) {
      if (visited.has(sha)) continue;
      visited.add(sha);
      out.push([sha, depth]);
      if (haves.has(sha)) continue;
      const c = repo.commits.get(sha);
      if (c === undefined) continue;
      for (const p of c.parents) if (!visited.has(p)) next.push(p);
    }
    frontier = next;
    depth += 1;
  }
  return out;
}

function handleFetchV2(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  let done = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('want ')) wants.push(a.slice(5));
    else if (a.startsWith('have ')) haves.push(a.slice(5));
    else if (a.startsWith('shallow ')) shallow.push(a.slice(8));
    else if (a.startsWith('deepen ')) deepen = parseInt(a.slice(7), 10);
    else if (a === 'done') done = true;
  }
  const haveSet = new Set(haves);
  const shallowSet = new Set(shallow);
  const { objs, shallow: shallowLines } = collectObjects(repo, wants, haveSet, shallowSet, deepen);

  // pack cache: the clone workload repeats the identical fetch. Node runs the request handler to
  // completion on one thread, so a synchronous build can never be raced: the first of 50 identical
  // concurrent fetches builds and caches, the rest hit the cache. Key on the request signature.
  const cache = (repo as unknown as { packCache?: Map<string, Buffer> });
  if (!cache.packCache) cache.packCache = new Map();
  const cacheKey = `${[...wants].sort().join(',')}|${[...haveSet].sort().join(',')}|${deepen ?? '-'}|${[...objs.keys()].sort().join(',')}`;
  const cached = cache.packCache.get(cacheKey);
  const pack = cached ?? writePack([...objs.values()]);
  if (cached === undefined && cache.packCache.size < 64) cache.packCache.set(cacheKey, pack);
  const sections: Buffer[] = [];
  // acknowledgments only when the client did NOT send done
  if (!done) {
    const lines: string[] = ['acknowledgments\n'];
    if (haves.length === 0) lines.push('NAK\n');
    else for (const h of haves) if (haveSet.has(h) && repo.commits.has(h)) lines.push(`ACK ${h}\n`);
    sections.push(Buffer.concat(lines.map(l => pkt(l))));
    sections.push(Buffer.from('0001', 'ascii')); // delim
  }
  if (shallowLines.length > 0) {
    sections.push(pkt('shallow-info\n'));
    sections.push(Buffer.concat(shallowLines.map(l => pkt(l))));
    sections.push(Buffer.from('0001', 'ascii'));
  }
  sections.push(pkt('packfile\n'));
  sections.push(sideband1(pack));
  sections.push(FLUSH);
  return Buffer.concat(sections);
}

// ---------- fetch (v0) ----------

function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const decoder = new PktDecoder();
  const packets = decoder.push(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  let caps = '';
  let done = false;
  let inWantSection = true;
  for (const p of packets) {
    if (p.kind === 'flush') { inWantSection = false; continue; }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (inWantSection) {
      const nul = line.indexOf('\0');
      if (nul >= 0) { caps = line.slice(nul + 1); }
      const clean = nul >= 0 ? line.slice(0, nul) : line;
      if (clean.startsWith('want ')) wants.push(clean.slice(5).split(' ')[0]);
      else if (clean.startsWith('shallow ')) shallow.push(clean.slice(8));
      else if (clean.startsWith('deepen ')) deepen = parseInt(clean.slice(7), 10);
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5));
      else if (line === 'done') done = true;
    }
  }
  const haveSet = new Set(haves);
  const shallowSet = new Set(shallow);
  const { objs, shallow: shallowLines } = collectObjects(repo, wants, haveSet, shallowSet, deepen);
  const pack = writePack([...objs.values()]);

  const sideband = caps.includes('side-band-64k') || caps.includes('side-band');
  const parts: Buffer[] = [];
  if (!done) {
    // NAK / ACK lines first
    if (haves.length === 0) parts.push(pkt('NAK\n'));
  } else if (haves.length > 0 && caps.includes('multi_ack_detailed')) {
    for (const h of haves) if (repo.commits.has(h)) parts.push(pkt(`ACK ${h} common\n`));
  }
  if (!done) {
    // without done, the negotiation continues: NAK and stop (client will re-POST)
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  for (const line of shallowLines) parts.push(pkt(line));
  parts.push(pkt('NAK\n'));
  if (sideband) {
    parts.push(sideband1(pack), FLUSH);
  } else {
    parts.push(pack);
  }
  return Buffer.concat(parts);
}

// ---------- receive-pack (push) ----------

interface PushCommand { oldOid: string; newOid: string; ref: string; }

function handleReceivePack(repo: Repo, body: Buffer, capReq: string): Buffer {
  // Walk pkt-lines until the flush; the raw pack bytes begin immediately after it.
  const commands: PushCommand[] = [];
  let caps = capReq;
  let seenCommands = false;
  let packStart = body.length;
  {
    let off = 0;
    while (off + 4 <= body.length) {
      const hex = body.subarray(off, off + 4).toString('ascii');
      const len = parseInt(hex, 16);
      if (!Number.isFinite(len) || hex.trim() === '') break; // non-pkt data: the pack
      if (len < 4) { off += 4; seenCommands = true; break; } // flush: commands done
      if (off + len > body.length) break; // partial pkt: malformed
      const line = body.subarray(off + 4, off + len).toString('utf8').replace(/\n$/, '');
      off += len;
      const nul = line.indexOf('\0');
      let clean = line;
      if (nul >= 0) { caps = line.slice(nul + 1); clean = line.slice(0, nul); }
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/\S+)$/.exec(clean);
      if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
    }
    if (off + 4 <= body.length && parseInt(body.subarray(off, off + 4).toString('ascii'), 16) === 0) {
      seenCommands = true;
      packStart = off + 4;
    } else {
      packStart = off; // no flush seen: treat the rest as pack bytes (lenient)
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let unpackOk = true;
  let unpackErr = '';
  const objects = new Map<string, GitObj>();

  const anyCreateUpdate = commands.some(c => c.newOid !== '0'.repeat(40));
  const packBytes = seenCommands && anyCreateUpdate ? body.subarray(packStart) : null;

  if (packBytes !== null && packBytes.length > 0) {
    try {
      const read = readPack(packBytes);
      for (const [oid, obj] of read) objects.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackErr = err instanceof Error ? err.message : String(err);
    }
  }

  const blobStore = blobs(repo);
  if (unpackOk) {
    for (const cmd of commands) {
      const zero = '0'.repeat(40);
      if (cmd.newOid === zero) {
        // delete
        if (cmd.ref.startsWith('refs/heads/')) {
          repo.branches.delete(cmd.ref.slice('refs/heads/'.length));
          const staleD = repo as unknown as { packCache?: Map<string, Buffer>; refGen?: number };
          staleD.packCache?.clear();
          staleD.refGen = (staleD.refGen ?? 0) + 1;
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        } else if (cmd.ref.startsWith('refs/tags/')) {
          tagsOf(repo).delete(cmd.ref.slice('refs/tags/'.length));
          const staleT = repo as unknown as { packCache?: Map<string, Buffer>; refGen?: number };
          staleT.packCache?.clear();
          staleT.refGen = (staleT.refGen ?? 0) + 1;
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        } else if (cmd.ref === 'HEAD') {
          results.push({ ref: cmd.ref, ok: false, reason: 'refusing to delete the current branch' });
        } else {
          results.push({ ref: cmd.ref, ok: false, reason: 'deletion not allowed here' });
        }
        continue;
      }
      // verify objects exist for the new tip (commit chain reachable from pack or store)
      const missing = !objects.has(cmd.newOid) && !repo.commits.has(cmd.newOid) && !objectsForOid(objects, cmd.newOid);
      if (missing) { results.push({ ref: cmd.ref, ok: false, reason: 'missing necessary objects' }); continue; }
      // non-fast-forward check
      if (cmd.oldOid !== zero) {
        const cur = cmd.ref.startsWith('refs/heads/') ? repo.branches.get(cmd.ref.slice('refs/heads/'.length)) : tagsOf(repo).get(cmd.ref.slice('refs/tags/'.length));
        if (cur !== undefined && cur !== cmd.oldOid) {
          results.push({ ref: cmd.ref, ok: false, reason: 'fetch first' });
          continue;
        }
        if (cur !== undefined && !isAncestor(repo, cmd.oldOid, cmd.newOid, objects)) {
          results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      // apply: absorb new objects into the store
      absorbObjects(repo, objects, cmd.newOid, blobStore);
      if (cmd.ref.startsWith('refs/heads/')) repo.branches.set(cmd.ref.slice('refs/heads/'.length), cmd.newOid);
      else if (cmd.ref.startsWith('refs/tags/')) tagsOf(repo).set(cmd.ref.slice('refs/tags/'.length), cmd.newOid);
      else if (cmd.ref === 'HEAD') repo.branches.set(repo.defaultBranch, cmd.newOid);
      // refs changed: the fetch pack cache and the ref list cache for this repo are stale
      const stale = repo as unknown as { packCache?: Map<string, Buffer>; refGen?: number; refGenCache?: Map<number, unknown> };
      stale.packCache?.clear();
      stale.refGen = (stale.refGen ?? 0) + 1;
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    }
  } else {
    for (const cmd of commands) results.push({ ref: cmd.ref, ok: false, reason: `unpack failed: ${unpackErr}` });
  }

  // absorb blobs for any pushed commit (objects map holds everything from the pack)
  for (const [, obj] of objects) {
    if (obj.type === 'blob') blobStore.set(obj.oid, obj.data.toString('utf8'));
  }

  // report-status (v2 style ok/ng lines), wrapped in side-band when requested
  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${'unpack failed'}\n`];
  for (const r of results) {
    reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  const report = Buffer.concat(reportLines.map(l => pkt(l)));
  report.push; // noop
  const useSideband = caps.includes('side-band-64k');
  if (useSideband) {
    return Buffer.concat([sideband1(report), FLUSH]);
  }
  return Buffer.concat([report, FLUSH]);
}

function objectsForOid(objects: Map<string, GitObj>, oid: string): boolean {
  return objects.has(oid);
}

function isAncestor(repo: Repo, maybeAncestor: string, descendant: string, objects: Map<string, GitObj>): boolean {
  // walk descendant's parents (in-store commits + pack commits)
  const parentOf = (sha: string): string[] => {
    const inStore = repo.commits.get(sha);
    if (inStore !== undefined) return inStore.parents;
    const obj = objects.get(sha);
    if (obj !== undefined && obj.type === 'commit') return parseCommit(obj.data).parents;
    return [];
  };
  if (maybeAncestor === descendant) return true;
  const visited = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (visited.has(sha)) continue;
    visited.add(sha);
    if (sha === maybeAncestor) return true;
    for (const p of parentOf(sha)) if (!visited.has(p)) stack.push(p);
  }
  return false;
}

/** Absorb a pushed commit + its tree + blobs into the forge store. */
function absorbObjects(repo: Repo, objects: Map<string, GitObj>, tip: string, blobStore: BlobStore): void {
  // walk commit objects from the pack (they are not in repo.commits yet)
  const commitObjs = [...objects.values()].filter(o => o.type === 'commit');
  for (const c of commitObjs) {
    const parsed = parseCommit(c.data);
    const treeEntries = parseTree? undefined as never : null; // placeholder, tree resolved below
    // tree: look up the tree object for this commit
    const treeObj = objects.get(parsed.tree);
    const tree: Record<string, string> = {};
    if (treeObj !== undefined && treeObj.type === 'tree') {
      // one entry per path (flat) OR nested; walk recursively
      const walk = (entries: ReturnType<typeof parseTree>, prefix: string): void => {
        for (const ent of entries) {
          if (ent.mode === '40000') {
            const sub = objects.get(ent.oid);
            if (sub !== undefined && sub.type === 'tree') walk(parseTree(sub.data), `${prefix}${ent.name}/`);
          } else {
            tree[`${prefix}${ent.name}`] = ent.oid;
          }
        }
      };
      walk(parseTree(treeObj.data), '');
    }
    if (!repo.commits.has(c.oid)) {
      repo.commits.set(c.oid, {
        sha: c.oid, message: parsed.message, tree,
        parents: parsed.parents, lc: (repo.commits.size + 1) * 1,
      });
      // keep the pushed commit's exact bytes for byte-exact clones
      const rawMap = (repo as unknown as { commitRaws?: Map<string, Buffer> });
      if (!rawMap.commitRaws) rawMap.commitRaws = new Map();
      rawMap.commitRaws.set(c.oid, c.data);
    }
    for (const [path, blobSha] of Object.entries(tree)) {
      const blobObj = objects.get(blobSha);
      if (blobObj !== undefined && blobObj.type === 'blob') blobStore.set(blobSha, blobObj.data.toString('utf8'));
    }
  }
  // raw trees for byte-exact fetches later
  const rawTrees = (repo as unknown as { treeRaws?: Map<string, Buffer> });
  if (!rawTrees.treeRaws) rawTrees.treeRaws = new Map();
  for (const [, obj] of objects) {
    if (obj.type === 'tree') rawTrees.treeRaws.set(obj.oid, obj.data);
  }
  // annotated tags: keep the whole object (oid + raw bytes) for byte-exact re-delivery
  for (const [, obj] of objects) {
    if (obj.type !== 'tag') continue;
    const text = obj.data.toString('utf8');
    const m = /^object ([0-9a-f]{40})/m.exec(text);
    if (m === null) continue;
    tagObjects(repo).set(obj.oid, obj);
  }
}

// ---------- router ----------

export function handleGit(ctx: GitCtx): boolean {
  const repo = getRepoAnyOwner(ctx.repoName);
  const { res } = ctx;
  const sendGit = (status: number, contentType: string, body: Buffer | string, extra: Record<string, string> = {}): void => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-cache', ...extra });
    res.end(buf);
  };

  if (ctx.method === 'GET' && ctx.path.endsWith('/info/refs')) {
    if (repo === undefined) { sendGit(404, 'text/plain; charset=utf-8', 'Not Found'); return true; }
    const service = ctx.query.get('service');
    if (service === 'git-upload-pack') {
      const body = ctx.protocolV2 ? advertiseUploadPackV2() : advertiseV0('git-upload-pack', repo, true);
      sendGit(200, 'application/x-git-upload-pack-advertisement', body);
      return true;
    }
    if (service === 'git-receive-pack') {
      sendGit(200, 'application/x-git-receive-pack-advertisement', advertiseV0('git-receive-pack', repo, true));
      return true;
    }
    sendGit(400, 'text/plain; charset=utf-8', 'dumb http protocol not supported');
    return true;
  }

  if (ctx.method === 'POST') {
    if (ctx.path.endsWith('/git-upload-pack')) {
      if (repo === undefined) { sendGit(404, 'text/plain; charset=utf-8', 'Not Found'); return true; }
      const body = ctx.protocolV2 ? handleV2Command(repo, ctx.body) : handleFetchV0(repo, ctx.body);
      sendGit(200, 'application/x-git-upload-pack-result', body);
      return true;
    }
    if (ctx.path.endsWith('/git-receive-pack')) {
      if (repo === undefined) { sendGit(404, 'text/plain; charset=utf-8', 'Not Found'); return true; }
      const tRp0 = performance.now();
      const rp = handleReceivePack(repo, ctx.body, '');
      if (process.env.FORGE_DEBUG) console.error(`DBG receive-pack server-side ${ (performance.now() - tRp0).toFixed(2) }ms body=${ctx.body.length}B`);
      sendGit(200, 'application/x-git-receive-pack-result', rp);
      return true;
    }
  }

  sendGit(404, 'text/plain; charset=utf-8', 'Not Found');
  return true;
}

/** v2 command request: command=ls-refs | fetch, capabilities, delim, args, flush */
function handleV2Command(repo: Repo, body: Buffer): Buffer {
  const decoder = new PktDecoder();
  const packets = decoder.push(body);
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') { pastDelim = true; continue; }
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) {
      if (line.startsWith('command=')) command = line.slice(8);
    } else {
      if (line !== '') args.push(line);
    }
  }
  if (command === 'ls-refs') return lsRefs(repo, args);
  if (command === 'fetch') return handleFetchV2(repo, args);
  return Buffer.concat([pkt(`ERR unknown command ${command}\n`), FLUSH]);
}
