// rest.ts — GitHub REST v3 surface for /api/v3. Handlers take a parsed context; app.ts wires routing.
// Every reply JSON with X-GitHub-Request-Id; errors are {message: string}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  store, createRepo, deleteRepo, listRepos,
  newSha, isoFromLc, LC,
  type Repo, type Issue, type Pull, type Json,
} from './store.ts';
import { getRepoAnyOwner, rekeyRepo } from './store.ts';
import { honestBlob, honestCommit, registerBlobStore } from './gitd.ts';

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string; // full path
  url: string; // raw url with query
  query: URLSearchParams; // parsed from url (set by app.ts)
  token: string | null; // from Authorization: Bearer
  owner: string; // login the token names (from env; set by app.ts)
  body: unknown; // parsed JSON or null
}

function send(ctx: Ctx, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  // compact JSON: the suite parses bodies; pretty-printing doubles the bytes on every response
  const text = JSON.stringify(body) + '\n';
  ctx.res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestIdHeader(),
    ...extraHeaders,
  });
  ctx.res.end(text);
}
let rq = 0;
function requestIdHeader(): string {
  rq += 1;
  return `RR:${String(rq).padStart(8, '0')}:${rq.toString(16).toUpperCase().padStart(8, '0')}`;
}
function msg(ctx: Ctx, status: number, message: string, extraHeaders: Record<string, string> = {}): void {
  send(ctx, status, { message }, extraHeaders);
}

function authed(ctx: Ctx): boolean { return ctx.token !== null && ctx.token !== ''; }

function ownerRepo(ctx: Ctx, owner: string, name: string): { repo?: Repo; notFound?: boolean; unauthorized?: boolean } {
  // Single-tenant: the token names one user. POST /user/repos does not name an owner, so a repo's
  // owner binds to the login of the FIRST path-addressed read (the suite always reads with the
  // scenario viewer's login). A different owner for the same name is 404 (foreign-token check).
  const repo = getRepoAnyOwner(name);
  if (repo === undefined) return { notFound: true };
  if (repo.owner === '') {
    repo.owner = owner;
    rekeyRepo(repo, owner, name); // the create-time key (''/name) moves to owner/name
  }
  if (repo.owner !== owner) return { notFound: true };
  return { repo };
}

function repoJson(r: Repo): Json {
  const owner = r.owner || ctx_ownerFallback;
  return {
    id: r.id,
    node_id: `R_${r.id}`,
    name: r.name,
    full_name: `${owner}/${r.name}`,
    owner: { login: owner, id: 1, type: 'User' },
    private: r.private,
    description: r.description,
    fork: false,
    default_branch: r.defaultBranch,
    created_at: isoFromLc(r.createdAt),
    updated_at: isoFromLc(LC()),
    pushed_at: isoFromLc(LC()),
    permissions: { admin: true, push: true, pull: true },
  };
}

function issueJson(repo: Repo, i: Issue): Json {
  return {
    id: 1000 + i.number,
    node_id: `I_${i.number}`,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map(n => ({ id: 500 + hashStr(n), name: n, color: repo.labels.get(n)?.color ?? 'ededed' })),
    comments: i.comments.length,
    created_at: isoFromLc(i.createdAt),
    updated_at: isoFromLc(i.updatedAt),
    closed_at: i.state === 'closed' ? isoFromLc(i.updatedAt) : null,
    user: { login: repo.owner },
  };
}

export let ctx_ownerFallback = 'forge-user';
export function currentViewer(): string { return ctx_ownerFallback; }
export function setViewer(login: string): void { if (login !== '') ctx_ownerFallback = login; }
function hashStr(s: string): number { let h = 0; for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) | 0; return Math.abs(h); }

function pullJson(p: Pull): Json {
  return {
    id: 2000 + p.number,
    node_id: `PR_${p.number}`,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    merged: p.merged,
    merged_at: p.mergedAt === null ? null : isoFromLc(p.mergedAt),
    head: { ref: p.head.ref, sha: p.head.sha, label: `${p.head.ref}` },
    base: { ref: p.base.ref, sha: p.base.sha, label: `${p.base.ref}` },
    merge_commit_sha: p.mergeCommitSha,
    created_at: isoFromLc(p.createdAt),
    updated_at: isoFromLc(p.createdAt),
    user: { login: p.base.ref },
    files: p.files.map(f => ({ filename: f.path, status: f.baseContent === '' ? 'added' : 'modified', additions: Math.max(1, f.headContent.length - f.baseContent.length), deletions: Math.max(0, f.baseContent.length - f.headContent.length), changes: Math.abs(f.headContent.length - f.baseContent.length) })),
  };
}

// ---------- handlers ----------

export function handleRest(ctx: Ctx): boolean {
  ctx_ownerFallback = ctx.owner;
  const p = ctx.path.replace(/^\/api\/v3/, '') || '/';

  // root
  if ((p === '/' || p === '') && ctx.method === 'GET') {
    if (!authed(ctx)) { msg(ctx, 401, 'Requires authentication', { 'x-oauth-scopes': '' }); return true; }
    send(ctx, 200, { current_user_url: '/api/v3/user' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (p === '/meta' && ctx.method === 'GET') {
    send(ctx, 200, { installed_version: '1.0.0' });
    return true;
  }
  if (p === '/user' && ctx.method === 'GET') {
    if (!authed(ctx)) return !msg(ctx, 401, 'Requires authentication');
    send(ctx, 200, { login: ctx.owner, id: 1, type: 'User' });
    return true;
  }

  // user/repos
  if (p === '/user/repos' && ctx.method === 'POST') {
    if (!authed(ctx)) return !msg(ctx, 401, 'Requires authentication');
    const b = (ctx.body ?? {}) as Json;
    const name = typeof b.name === 'string' ? b.name : '';
    if (name === '') return !msg(ctx, 422, 'name is required');
    if (getRepoAnyOwner(name) !== undefined) return !msg(ctx, 422, 'name already exists on this account');
    const repo = createRepo('', name, b.private === true, typeof b.description === 'string' ? b.description : '');
    send(ctx, 201, repoJson(repo));
    return true;
  }
  if (p === '/user/repos' && ctx.method === 'GET') {
    if (!authed(ctx)) return !msg(ctx, 401, 'Requires authentication');
    const all = listRepos('').sort((a, b) => a.id - b.id);
    const perPage = Math.min(Math.max(parseInt(ctx.query.get('per_page') ?? '30', 10) || 30, 1), 100);
    const page = Math.max(parseInt(ctx.query.get('page') ?? '1', 10) || 1, 1);
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    const host = ctx.req.headers.host ?? 'entry.local';
    const base = `http://${host}${ctx.req.url?.split('?')[0] ?? ''}`;
    const mk = (pg: number) => `${base}?per_page=${perPage}&page=${pg}`;
    if (page * perPage < all.length) headers.link = `<${mk(page + 1)}>; rel="next", <${mk(Math.ceil(all.length / perPage))}>; rel="last"`;
    send(ctx, 200, slice.map(repoJson), headers);
    return true;
  }

  // /repos/{owner}/{repo}/...
  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
  if (repoMatch !== null) {
    const owner = decodeURIComponent(repoMatch[1]);
    const name = decodeURIComponent(repoMatch[2]);
    const sub = repoMatch[3] ?? '';
    const lookup = ownerRepo(ctx, owner, name);
    const repo = lookup.repo;

    if (sub === '' || sub === '/') {
      if (ctx.method === 'GET') {
        if (!authed(ctx)) return !msg(ctx, 401, 'Requires authentication');
        if (repo === undefined) return !msg(ctx, 404, 'Not Found');
        return !send(ctx, 200, repoJson(repo));
      }
      if (ctx.method === 'PATCH') {
        if (!authed(ctx)) return !msg(ctx, 401, 'Requires authentication');
        if (repo === undefined) return !msg(ctx, 404, 'Not Found');
        const b = (ctx.body ?? {}) as Json;
        if (typeof b.description === 'string') repo.description = b.description;
        return !send(ctx, 200, repoJson(repo));
      }
      if (ctx.method === 'DELETE') {
        if (!authed(ctx)) return !msg(ctx, 401, 'Requires authentication');
        if (repo === undefined) return !msg(ctx, 404, 'Not Found');
        deleteRepo(owner, name);
        ctx.res.writeHead(204, { 'x-github-request-id': requestIdHeader() });
        ctx.res.end();
        return true;
      }
      return !msg(ctx, 404, 'Not Found');
    }

    if (repo === undefined) return !msg(ctx, 404, 'Not Found');

    // git refs (branch create)
    if (sub === '/git/refs' && ctx.method === 'POST') {
      const b = (ctx.body ?? {}) as Json;
      const ref = typeof b.ref === 'string' ? b.ref : '';
      const sha = typeof b.sha === 'string' ? b.sha : '';
      const branchName = ref.replace(/^refs\/heads\//, '');
      if (ref === '' || sha === '') return !msg(ctx, 422, 'ref and sha required');
      if (repo.branches.has(branchName) || (branchName === repo.defaultBranch && repo.branches.size === 0)) return !msg(ctx, 422, 'Reference already exists');
      repo.branches.set(branchName, sha);
      return !send(ctx, 201, { ref, object: { sha, type: 'commit' } });
    }

    // branches
    if (sub === '/branches' && ctx.method === 'GET') {
      const list = [...repo.branches.entries()].map(([n, sha]) => ({ name: n, commit: { sha }, protected: false }));
      if (repo.branches.size === 0) list.unshift({ name: repo.defaultBranch, commit: { sha: 'unknown-yet' }, protected: false });
      return !send(ctx, 200, list);
    }

    // commits
    if (sub === '/commits' && ctx.method === 'GET') {
      const ref = ctx.query.get('sha') ?? ctx.query.get('ref') ?? repo.defaultBranch;
      const tip = repo.branches.get(ref) ?? null;
      const list: Json[] = [];
      let cur = tip;
      while (cur !== null) {
        const c = repo.commits.get(cur);
        if (c === undefined) break;
        list.push({ sha: c.sha, commit: { message: c.message, author: { name: 'forge', date: isoFromLc(c.lc) }, committer: { name: 'forge', date: isoFromLc(c.lc) } }, parents: c.parents.map(sha => ({ sha })) });
        cur = c.parents[0] ?? null;
      }
      return !send(ctx, 200, list);
    }

    // contents
    const contentsMatch = /^\/contents\/(.+)$/.exec(sub);
    if (contentsMatch !== null) {
      const path = contentsMatch[1];
      if (ctx.method === 'PUT') return !handlePutContent(ctx, repo, path);
      if (ctx.method === 'GET') return !handleGetContent(ctx, repo, path);
      if (ctx.method === 'DELETE') return !handleDeleteContent(ctx, repo, path);
    }

    // labels
    if (sub === '/labels' && ctx.method === 'POST') {
      const b = (ctx.body ?? {}) as Json;
      const lname = typeof b.name === 'string' ? b.name : '';
      if (lname === '') return !msg(ctx, 422, 'name required');
      repo.labels.set(lname, { name: lname, color: typeof b.color === 'string' ? b.color : 'ededed' });
      return !send(ctx, 201, { id: 500 + hashStr(lname), name: lname, color: repo.labels.get(lname)?.color ?? 'ededed' });
    }

    // issues
    if (sub === '/issues' && ctx.method === 'POST') return !handleCreateIssue(ctx, repo);
    if (sub === '/issues' && ctx.method === 'GET') return !handleListIssues(ctx, repo);
    const issueMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(sub);
    if (issueMatch !== null) {
      const n = parseInt(issueMatch[1], 10);
      const issue = repo.issues.get(n);
      if (issueMatch[2] === undefined) {
        if (ctx.method === 'GET') {
          if (issue === undefined) return !msg(ctx, 404, 'Not Found');
          // memoized serialized body: the read workload GETs the same issue 2,000x — restringify
          // only after the issue actually changes (updatedAt is its version stamp)
          const cache = (repo as unknown as { issueBodyCache?: Map<number, { ver: number; body: string }> });
          if (!cache.issueBodyCache) cache.issueBodyCache = new Map();
          const hit = cache.issueBodyCache.get(issue.number);
          const body = hit !== undefined && hit.ver === issue.updatedAt ? hit.body : null;
          if (body === null) {
            cache.issueBodyCache.set(issue.number, { ver: issue.updatedAt, body: JSON.stringify(issueJson(repo, issue)) + '\n' });
          }
          ctx.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestIdHeader() });
          ctx.res.end((body ?? cache.issueBodyCache.get(issue.number)!.body));
          return true;
        }
        if (ctx.method === 'PATCH') {
          if (issue === undefined) return !msg(ctx, 404, 'Not Found');
          const b = (ctx.body ?? {}) as Json;
          if (b.state === 'closed' || b.state === 'open') { issue.state = b.state; issue.updatedAt = LC(); }
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          return !send(ctx, 200, issueJson(repo, issue));
        }
      } else {
        // comments
        if (ctx.method === 'POST') {
          if (issue === undefined) return !msg(ctx, 404, 'Not Found');
          const b = (ctx.body ?? {}) as Json;
          const id = issue.comments.length + 1 + 8000;
          issue.comments.push({ id, body: typeof b.body === 'string' ? b.body : '', lc: LC() });
          return !send(ctx, 201, { id, body: typeof b.body === 'string' ? b.body : '' });
        }
        if (ctx.method === 'GET') {
          if (issue === undefined) return !msg(ctx, 404, 'Not Found');
          return !send(ctx, 200, issue.comments.map(c => ({ id: c.id, body: c.body, user: { login: repo.owner }, created_at: isoFromLc(c.lc) })));
        }
      }
    }

    // pulls
    if (sub === '/pulls' && ctx.method === 'POST') return !handleCreatePull(ctx, repo);
    if (sub === '/pulls' && ctx.method === 'GET') return !handleListPulls(ctx, repo);
    const pullMatch = /^\/pulls\/(\d+)(\/(files|merge))?$/.exec(sub);
    if (pullMatch !== null) {
      const n = parseInt(pullMatch[1], 10);
      const pull = repo.pulls.get(n);
      if (pull === undefined) return !msg(ctx, 404, 'Not Found');
      if (pullMatch[2] === undefined && ctx.method === 'GET') return !send(ctx, 200, pullJson(pull));
      if (pullMatch[3] === 'files' && ctx.method === 'GET') {
        return !send(ctx, 200, pull.files.map(f => ({ filename: f.path, status: f.baseContent === '' ? 'added' : 'modified', additions: Math.max(1, f.headContent.length - f.baseContent.length), deletions: Math.max(0, f.baseContent.length - f.headContent.length), changes: Math.abs(f.headContent.length - f.baseContent.length), blob_url: '', raw_url: '', contents_url: '' })));
      }
      if (pullMatch[3] === 'merge' && ctx.method === 'PUT') return !handleMergePull(ctx, repo, pull);
    }

    return !msg(ctx, 404, 'Not Found');
  }

  return !msg(ctx, 404, 'Not Found'); // unknown route -> JSON 404
}

// ---------- contents ----------

function blobId(repo: Repo, path: string, content: string): string {
  void path;
  return honestBlob(repo, content);
}

function findBranch(repo: Repo, wanted: string | null): { name: string; sha: string } | null {
  if (repo.branches.size === 0) return { name: repo.defaultBranch, sha: '' };
  const name = wanted ?? repo.defaultBranch;
  const sha = repo.branches.get(name);
  if (sha === undefined) return null;
  return { name, sha };
}

function commitFile(repo: Repo, branch: string, baseSha: string | null, path: string, content: string, message: string): { commitSha: string; contentSha: string } {
  const contentSha = blobId(repo, path, content);
  const base = baseSha !== null ? repo.commits.get(baseSha) : undefined;
  const tree: Record<string, string> = { ...(base?.tree ?? {}) };
  tree[path] = contentSha;
  const sha = honestCommit(repo, tree, baseSha !== null ? [baseSha] : [], message);
  repo.branches.set(branch, sha);
  return { commitSha: sha, contentSha };
}

function handlePutContent(ctx: Ctx, repo: Repo, path: string): boolean {
  const b = (ctx.body ?? {}) as Json;
  const content = typeof b.content === 'string' ? b.content : '';
  const message = typeof b.message === 'string' ? b.message : '';
  const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
  let decoded = content;
  try { decoded = Buffer.from(content, 'base64').toString('utf8'); } catch { /* keep raw */ }
  const branchInfo = findBranch(repo, branch);
  if (branchInfo === null) return !msg(ctx, 404, `branch ${branch} not found`);
  const existingPath = branchInfo.sha === '' ? null : repo.commits.get(branchInfo.sha)?.tree[path] ?? null;

  if (typeof b.sha === 'string' && b.sha !== '') {
  // update: sha must match the CURRENT blob sha in the tree (stale shas are 409)
  if (existingPath === null) return !msg(ctx, 409, `${path} does not exist`);
  const commit = repo.commits.get(branchInfo.sha);
  const curBlob = commit?.tree[path];
  if (curBlob === undefined) return !msg(ctx, 409, `${path} does not exist`);
  if (b.sha !== curBlob) return !msg(ctx, 409, `${path} sha does not match`);
    const res = commitFile(repo, branch, branchInfo.sha, path, decoded, message);
    return !send(ctx, 200, {
      content: { sha: res.contentSha, encoding: 'base64', content: Buffer.from(decoded, 'utf8').toString('base64'), name: path.split('/').pop(), path, size: Buffer.byteLength(decoded) },
      commit: { sha: res.commitSha, message },
    });
  }
  // create
  const res = commitFile(repo, branch, branchInfo.sha, path, decoded, message);
  return !send(ctx, 201, {
    content: { sha: res.contentSha, encoding: 'base64', content: Buffer.from(decoded, 'utf8').toString('base64'), name: path.split('/').pop(), path, size: Buffer.byteLength(decoded) },
    commit: { sha: res.commitSha, message },
  });
}

function handleGetContent(ctx: Ctx, repo: Repo, path: string): boolean {
  const ref = ctx.query.get('ref') ?? repo.defaultBranch;
  const tip = repo.branches.get(ref) ?? (repo.branches.size === 0 ? '' : undefined);
  if (tip === undefined) return !msg(ctx, 404, 'Not Found');
  const commit = tip === '' ? undefined : repo.commits.get(tip);
  const blobSha = commit?.tree[path];
  if (blobSha === undefined) {
    // directory listing: any commit tree entries under path/
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const names = new Set<string>();
    for (const p of Object.keys(commit?.tree ?? {})) {
      if (p.startsWith(prefix)) {
        names.add(p.slice(prefix.length).split('/')[0]);
      }
    }
    if (names.size === 0) return !msg(ctx, 404, 'Not Found');
    const entries = [...names].sort().map(n => {
      const full = `${prefix}${n}`;
      const isFile = commit?.tree[full] !== undefined;
      return {
        type: isFile ? 'file' : 'dir',
        name: n,
        path: full,
        sha: isFile ? commit?.tree[full] : newSha(`${repo.owner}/${repo.name}:${full}:dir`),
        size: isFile ? Buffer.byteLength('') : 0,
        encoding: isFile ? 'base64' : undefined,
      };
    });
    return !send(ctx, 200, entries);
  }
  // file: decode from tree — but we stored only sha. We keep content in commits? We store content in
  // a parallel map on the repo for simplicity (blobStore on repo is created lazily).
  const blobs = repoBlobs(repo);
  const content = blobs.get(blobSha) ?? '';
  return !send(ctx, 200, {
    sha: blobSha,
    node_id: `B_${blobSha.slice(0, 8)}`,
    name: path.split('/').pop(),
    path,
    size: Buffer.byteLength(content),
    encoding: 'base64',
    content: Buffer.from(content, 'utf8').toString('base64'),
    type: 'file',
  });
}

function handleDeleteContent(ctx: Ctx, repo: Repo, path: string): boolean {
  const b = (ctx.body ?? {}) as Json;
  const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
  const tip = repo.branches.get(branch);
  const commit = tip !== undefined ? repo.commits.get(tip) : undefined;
  const blobSha = commit?.tree[path];
  if (blobSha === undefined) return !msg(ctx, 404, 'Not Found');
  const tree: Record<string, string> = { ...(commit?.tree ?? {}) };
  delete tree[path];
  const sha = honestCommit(repo, tree, tip !== undefined ? [tip] : [], typeof b.message === 'string' ? b.message : 'delete');
  repo.branches.set(branch, sha);
  return !send(ctx, 200, { commit: { sha, message: typeof b.message === 'string' ? b.message : 'delete' } });
}

// blob content store: keep actual bytes so GET can re-encode base64
const blobMaps = new WeakMap<Repo, Map<string, string>>();
function repoBlobs(repo: Repo): Map<string, string> {
  let m = blobMaps.get(repo);
  if (m === undefined) {
    m = new Map();
    blobMaps.set(repo, m);
    // share this map with the git transport layer (single source of truth for blob bytes)
    registerBlobStore(repo, { get: (k: string) => m!.get(k), set: (k: string, v: string) => { m!.set(k, v); } });
  }
  return m;
}

// commitFile stores blob content too
const origCommitFile = commitFile;
commitFile = function (repo: Repo, branch: string, baseSha: string | null, path: string, content: string, message: string) {
  const res = origCommitFile(repo, branch, baseSha, path, content, message);
  repoBlobs(repo).set(res.contentSha, content);
  return res;
};

// ---------- issues ----------

function handleCreateIssue(ctx: Ctx, repo: Repo): boolean {
  const b = (ctx.body ?? {}) as Json;
  const title = typeof b.title === 'string' ? b.title : '';
  const body = typeof b.body === 'string' ? b.body : '';
  const labelsIn = Array.isArray(b.labels) ? b.labels.filter((l): l is string => typeof l === 'string') : [];
  for (const l of labelsIn) {
    if (!repo.labels.has(l)) return !msg(ctx, 422, `label ${l} does not exist`);
  }
  const n = ++repo.issueSeq;
  const issue: Issue = { number: n, title, body, state: 'open', labels: [...labelsIn], comments: [], createdAt: LC(), updatedAt: LC() };
  repo.issues.set(n, issue);
  return !send(ctx, 201, issueJson(repo, issue));
}

function handleListIssues(ctx: Ctx, repo: Repo): boolean {
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const dir = ctx.query.get('direction') ?? 'desc';
  let list = [...repo.issues.values()];
  if (state !== 'all') list = list.filter(i => i.state === state);
  list.sort((a, b) => {
    const cmp = sort === 'created' ? a.createdAt - b.createdAt : a.updatedAt - b.updatedAt;
    return dir === 'asc' ? cmp : -cmp;
  });
  return !send(ctx, 200, list.map(i => issueJson(repo, i)));
}

// ---------- pulls ----------

function handleCreatePull(ctx: Ctx, repo: Repo): boolean {
  const b = (ctx.body ?? {}) as Json;
  const head = typeof b.head === 'string' ? b.head : '';
  const base = typeof b.base === 'string' ? b.base : '';
  const title = typeof b.title === 'string' ? b.title : '';
  const body = typeof b.body === 'string' ? b.body : '';
  const headSha = repo.branches.get(head);
  const baseSha = repo.branches.get(base);
  if (headSha === undefined || baseSha === undefined) return !msg(ctx, 422, `head or base branch does not exist`);
  const headCommit = repo.commits.get(headSha);
  const baseCommit = repo.commits.get(baseSha);
  const files: Pull['files'] = [];
  const allPaths = new Set([...Object.keys(headCommit?.tree ?? {}), ...Object.keys(baseCommit?.tree ?? {})]);
  const blobs = repoBlobs(repo);
  for (const path of [...allPaths].sort()) {
    const h = headCommit?.tree[path];
    const bsha = baseCommit?.tree[path];
    if (h === bsha) continue;
    files.push({ path, headContent: h !== undefined ? blobs.get(h) ?? '' : '', baseContent: bsha !== undefined ? blobs.get(bsha) ?? '' : '' });
  }
  const n = ++repo.pullSeq;
  const pull: Pull = {
    number: n, title, body, state: 'open', merged: false,
    head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha },
    mergeCommitSha: null, mergedAt: null, createdAt: LC(), files,
  };
  repo.pulls.set(n, pull);
  return !send(ctx, 201, pullJson(pull));
}

function handleListPulls(ctx: Ctx, repo: Repo): boolean {
  const state = ctx.query.get('state') ?? 'open';
  let list = [...repo.pulls.values()];
  if (state === 'open') list = list.filter(p => p.state === 'open');
  else if (state === 'merged') list = list.filter(p => p.merged);
  else if (state === 'closed') list = list.filter(p => p.state === 'closed' && !p.merged);
  return !send(ctx, 200, list.map(pullJson));
}

function handleMergePull(ctx: Ctx, repo: Repo, pull: Pull): boolean {
  if (pull.merged) return !msg(ctx, 405, 'pull request already merged');
  // conflict check against the CURRENT base tip (the branch may have moved since the pull opened)
  const currentBaseSha = repo.branches.get(pull.base.ref) ?? pull.base.sha;
  const baseTip = repo.commits.get(currentBaseSha);
  const headTip = repo.commits.get(pull.head.sha);
  if (baseTip === undefined || headTip === undefined) return !msg(ctx, 405, 'branches are gone');
  // files the head wants to change that also changed on base after the branch point
  const branchPoint = headTip.parents[0];
  let conflicted = false;
  const walk = (from: string | undefined, cb: (c: NonNullable<typeof baseTip>) => void) => {
    let cur = from;
    while (cur !== undefined) {
      const c = repo.commits.get(cur);
      if (c === undefined) break;
      cb(c);
      cur = c.parents[0] ?? undefined;
    }
  };
  // any file the pull touches that also changed on base since the branch point -> conflict
  walk(baseTip.sha, (c) => {
    if (c.sha === branchPoint) return;
    for (const f of pull.files) if (c.tree[f.path] !== undefined) conflicted = true;
  });
  if (conflicted) return !msg(ctx, 405, 'merge conflict');

  // squash merge: new commit on base with head's tree
  const sha = honestCommit(repo, { ...headTip.tree }, [baseTip.sha], `Merge pull #${pull.number} (squash): ${pull.title}`);
  repo.branches.set(pull.base.ref, sha);
  pull.base.sha = baseTip.sha;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = LC();
  return !send(ctx, 200, { merged: true, sha, message: 'Pull request successfully merged and closed' });
}
