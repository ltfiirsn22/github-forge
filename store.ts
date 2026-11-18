// store.ts — forge in-memory store: repos, branches, commits, issues, labels, pulls.
// Determinism: every id/number comes from a counter; timestamps are logical (LC()).
// No Date.now, no Math.random anywhere in state.

import { createHash } from 'node:crypto';

export type Json = Record<string, unknown>;

let lc = 1_000_000_000; // logical clock: monotonic counter
export function LC(): number { return lc += 1; }

let reqId = 0;
export function requestId(): string {
  // Deterministic request id shaped like GitHub's (hex groups)
  reqId += 1;
  const n = Buffer.from(String(reqId)).toString('hex').toUpperCase();
  return `RU:${n.slice(0,4)}:${n.slice(4,10)}:${n.slice(10,16)}:${n.slice(16,22)}:${String(reqId % 9999).padStart(4,'0')}`;
}

export interface FileBlob { content: string; /* utf-8 */ }

export interface CommitNode {
  sha: string;
  message: string;
  tree: Record<string, string>; // path -> blobId (flat tree; ponnytail: no sub-tree objects yet)
  parents: string[];
  lc: number;
}

export interface Branch { name: string; sha: string; }

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: { id: number; body: string; lc: number }[];
  createdAt: number;
  updatedAt: number;
}

export interface Label { name: string; color: string; }

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  mergeCommitSha: string | null;
  mergedAt: number | null;
  createdAt: number;
  files: { path: string; headContent: string; baseContent: string }[];
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  branches: Map<string, string>; // name -> commit sha
  commits: Map<string, CommitNode>; // sha -> node
  issues: Map<number, Issue>;
  issueSeq: number;
  labels: Map<string, Label>;
  pulls: Map<number, Pull>;
  pullSeq: number;
  createdAt: number;
}

export const store = {
  repos: new Map<string, Repo>(), // key: owner/name
  userSeq: 0,
};

export function repoKey(owner: string, name: string): string { return `${owner}/${name}`.toLowerCase(); }

export function getRepo(owner: string, name: string): Repo | undefined {
  return store.repos.get(repoKey(owner, name));
}

/** Re-key a repo from its create-time key (''/name) to owner/name once the owner binds. */
export function rekeyRepo(repo: Repo, owner: string, name: string): void {
  store.repos.delete(repoKey('', name));
  store.repos.set(repoKey(owner, name), repo);
}

/** Find a repo by name alone (single-tenant: owner binds on first path-addressed read). */
export function getRepoAnyOwner(name: string): Repo | undefined {
  for (const r of store.repos.values()) if (r.name === name) return r;
  return undefined;
}

export function createRepo(owner: string, name: string, isPrivate: boolean, description: string, defaultBranch = 'main'): Repo {
  const repo: Repo = {
    id: ++store.userSeq,
    owner, name,
    private: isPrivate,
    description,
    defaultBranch,
    branches: new Map(),
    commits: new Map(),
    issues: new Map(),
    issueSeq: 0,
    labels: new Map(),
    pulls: new Map(),
    pullSeq: 0,
    createdAt: LC(),
  };
  store.repos.set(repoKey(owner, name), repo);
  return repo;
}

export function deleteRepo(owner: string, name: string): void {
  store.repos.delete(repoKey(owner, name));
}

export function listRepos(owner: string): Repo[] {
  if (owner === '') return [...store.repos.values()]; // single-tenant: every repo
  return [...store.repos.values()].filter(r => r.owner === owner);
}

// ------- sha helpers (deterministic) -------
let shaSeq = 0;
export function newSha(seed: string): string {
  // 40-hex from content-ish seed + counter; deterministic across runs given same inputs
  shaSeq += 1;
  return createHash('sha1').update(seed).update(String(shaSeq)).digest('hex');
}

export function newNodeId(kind: string, n: number): string {
  // GitHub-ish base64 node id; deterministic
  return Buffer.from(`${kind}:${n}`).toString('base64');
}

export function isoFromLc(v: number): string {
  // Deterministic ISO date derived from logical clock: base epoch + v seconds
  const base = 1760000000; // fixed epoch seconds (2025-10-09-ish); constant across runs
  return new Date((base + v) * 1000).toISOString().replace('.000Z', 'Z');
}
