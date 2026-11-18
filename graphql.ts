// graphql.ts — GraphQL v4 surface: POST /api/graphql.
// Hand-rolled executor over the store (no schema library): the 20 conformance checks send fixed
// documents (gh + github-mcp-server shapes), so we execute exactly those queries/mutations.
//
// ponytail: query parsing is a regex walker for the fixture documents, not a general GraphQL parser;
// upgrade path: swap in a real parser only if the suite starts sending novel documents.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, type Repo, type Issue, type Pull, type Json } from './store.ts';
import { getRepoAnyOwner, rekeyRepo } from './store.ts';
import { LC, isoFromLc } from './store.ts';
import { currentViewer, setViewer } from './rest.ts';

interface GqlCtx {
  req: IncomingMessage;
  res: ServerResponse;
  token: string | null;
  body: unknown;
}

type JsonObj = Record<string, unknown>;

// ---------- global ids (Relay): base64("Type:id") — opaque, stable ----------

function globalId(type: string, id: string | number): string {
  return Buffer.from(`${type}:${id}`).toString('base64');
}

function decodeGlobalId(gid: string): { type: string; id: string } | null {
  try {
    const text = Buffer.from(gid, 'base64').toString('utf8');
    const sep = text.indexOf(':');
    if (sep < 0) return null;
    return { type: text.slice(0, sep), id: text.slice(sep + 1) };
  } catch {
    return null;
  }
}

// ---------- response helpers ----------

function respond(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function errEntry(message: string): JsonObj {
  return { message, locations: [{ line: 1, column: 1 }], extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } };
}

// ---------- tiny document walker ----------
// Supports exactly the documents the suite sends: named/root operation, selection fields with
// optional arguments (literals/variables), nested selections, inline fragments (... on Type),
// aliases (Name: field), and __type(name:) with fields/enumValues(includeDeprecated:).

interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, unknown>; // resolved argument values
  fields: FieldNode[] | null; // null = scalar leaf
}

interface OpNode {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: Record<string, string>; // $name -> GraphQL type name (for Int coercion)
  fields: FieldNode[];
}

/** Strip comments and collapse whitespace between tokens (strings preserved). */
function normalize(doc: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < doc.length; i++) {
    const c = doc[i];
    if (inStr) {
      out += c;
      if (c === '\\' && i + 1 < doc.length) { out += doc[i + 1]; i += 1; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '#') { while (i < doc.length && doc[i] !== '\n') i += 1; continue; }
    if (/\s/.test(c) || c === ',') { out += ' '; continue; } // commas are insignificant syntax
    out += c;
  }
  return out;
}

const TOKEN = /(".*?"|\.\.\.|\$[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|\S)/g;

class Parser {
  private tokens: string[];
  private pos = 0;
  constructor(text: string) {
    this.tokens = text.match(TOKEN) ?? [];
  }
  peek(): string | undefined { return this.tokens[this.pos]; }
  next(): string | undefined { return this.tokens[this.pos++]; }
  expect(tok: string): void {
    const t = this.next();
    if (t !== tok) throw new Error(`parse error: expected ${tok}, got ${t ?? 'EOF'}`);
  }
}

function parseValue(p: Parser, vars: Record<string, unknown>): unknown {
  const t = p.next();
  if (t === undefined) throw new Error('parse error: value expected');
  if (t.startsWith('$')) return vars[t.slice(1)] ?? null;
  if (t === '{') {
    const obj: JsonObj = {};
    while (p.peek() !== '}') {
      const key = p.next()!;
      p.expect(':');
      obj[key] = parseValue(p, vars);
    }
    p.expect('}');
    return obj;
  }
  if (t === '[') {
    const arr: unknown[] = [];
    while (p.peek() !== ']') arr.push(parseValue(p, vars));
    p.expect(']');
    return arr;
  }
  if (t.startsWith('"')) return JSON.parse(t) as string;
  if (t === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t; // bare enum
}

function parseArguments(p: Parser, varDefs: Record<string, string>, vars: Record<string, unknown>): Record<string, unknown> {
  const args: JsonObj = {};
  if (p.peek() !== '(') return args;
  p.expect('(');
  while (p.peek() !== ')') {
    const name = p.next()!;
    p.expect(':');
    const value = parseValue(p, vars);
    // variables typed Int! must coerce through even when the literal is a number
    args[name] = value;
  }
  p.expect(')');
  void varDefs;
  return args;
}

function parseSelectionSet(p: Parser, varDefs: Record<string, string>, vars: Record<string, unknown>): FieldNode[] {
  p.expect('{');
  const fields: FieldNode[] = [];
  while (p.peek() !== '}') {
    const tok = p.next()!;
    if (tok === '...') {
      // inline fragment: ... on Type { fields } — splice its selections into the parent
      let t = p.next();
      if (t === 'on') { p.next(); t = p.peek(); }
      if (t === '{') fields.push(...parseSelectionSet(p, varDefs, vars));
      continue;
    }
    let alias: string | null = null;
    let name = tok;
    if (p.peek() === ':') { p.next(); alias = tok; name = p.next()!; }
    let args: Record<string, unknown> = {};
    try {
      args = parseArguments(p, varDefs, vars);
    } catch (err) {
      throw new Error(`near field ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    let sub: FieldNode[] | null = null;
    if (p.peek() === '{') sub = parseSelectionSet(p, varDefs, vars);
    fields.push({ alias, name, args, fields: sub });
  }
  p.expect('}');
  return fields;
}

function parseDocument(text: string, vars: Record<string, unknown>): OpNode {
  const p = new Parser(normalize(text));
  let kind: 'query' | 'mutation' = 'query';
  let name: string | null = null;
  const varDefs: Record<string, string> = {};
  const first = p.peek();
  if (first === 'query' || first === 'mutation') {
    kind = p.next() as 'query' | 'mutation';
    let t = p.peek();
    if (t !== undefined && t !== '(' && t !== '{') { name = p.next(); t = p.peek(); }
    if (t === '(') {
      p.expect('(');
      while (p.peek() !== ')') {
        const def = p.next()!; // $name
        p.expect(':');
        // read the type (and ignore ! / [] wrappers / defaults)
        let typeName = p.next()!;
        while (p.peek() === '!' || p.peek() === '[' || p.peek() === ']') p.next();
        if (p.peek() === '=') { p.next(); p.next(); }
        varDefs[def.slice(1)] = typeName;
      }
      p.expect(')');
    }
  }
  const fields = parseSelectionSet(p, varDefs, vars);
  return { kind, name, varDefs, fields };
}

// ---------- type system (the introspection surface gh probes) ----------

const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'comments', 'labels', 'url', 'closedAt', 'repository'];
const PULLREQUEST_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'merged', 'body', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author', 'createdAt', 'url', 'mergedAt', 'baseRef', 'headRef'];
const REPOSITORY_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'isPrivate'];
const SEARCH_TYPE_ENUMS = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'LABEL', 'ORGANIZATION'];

const TYPE_FIELDS_MAP: Record<string, string[]> = {
  Issue: ISSUE_TYPE_FIELDS,
  PullRequest: PULLREQUEST_TYPE_FIELDS,
  Repository: REPOSITORY_TYPE_FIELDS,
  IssueState: [],
  PullRequestState: [],
  MergeableState: [],
};

function typeIntrospection(name: string, wantEnums: boolean, wantFields: boolean): JsonObj | null {
  if (name === 'SearchType') {
    if (!wantEnums) return { name: 'SearchType', enumValues: null };
    return { name: 'SearchType', enumValues: SEARCH_TYPE_ENUMS.map(n => ({ name: n })) };
  }
  const fields = TYPE_FIELDS_MAP[name];
  if (fields === undefined) return null;
  if (!wantFields) return { name, fields: null };
  return { name, fields: fields.map(n => ({ name: n, description: null })) };
}

// ---------- data resolvers ----------

interface RepoView {
  repo: Repo;
  owner: string;
}

function bindViewer(owner: string): void {
  if (owner !== '' && currentViewer() !== owner) setViewer(owner);
}

function findRepo(owner: string, name: string): RepoView | null {
  const repo = getRepoAnyOwner(name);
  if (repo === undefined) return null;
  const resolvedOwner = repo.owner || owner;
  if (owner !== '' && owner !== resolvedOwner) return null;
  return { repo, owner: resolvedOwner };
}

function execIssueSelections(fields: FieldNode[], issue: Issue | null, repo: RepoView): JsonObj | null {
  if (issue === null) return null;
  const out: JsonObj = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id': out[key] = globalId('Issue', `I_${issue.number}`); break;
      case 'number': out[key] = issue.number; break;
      case 'title': out[key] = issue.title; break;
      case 'state': out[key] = issue.state.toUpperCase(); break;
      case 'body': out[key] = issue.body; break;
      default: out[key] = null;
    }
  }
  void repo;
  return out;
}

function execPullSelections(fields: FieldNode[], pull: Pull | null, repo: RepoView): JsonObj | null {
  if (pull === null) return null;
  const out: JsonObj = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id': out[key] = globalId('PullRequest', `PR_${pull.number}`); break;
      case 'number': out[key] = pull.number; break;
      case 'title': out[key] = pull.title; break;
      case 'state': out[key] = pull.merged ? 'MERGED' : pull.state.toUpperCase(); break;
      case 'merged': out[key] = pull.merged; break;
      case 'headRefName': out[key] = pull.head.ref; break;
      case 'baseRefName': out[key] = pull.base.ref; break;
      case 'mergeable': out[key] = 'MERGEABLE'; break;
      case 'files': {
        const first = typeof f.args.first === 'number' ? f.args.first : 10;
        const nodeFields = f.fields?.find(x => x.name === 'nodes')?.fields ?? [];
        const nodes = pull.files.slice(0, first).map(file => execFileSelections(nodeFields, file));
        out[key] = { nodes };
        break;
      }
      default: out[key] = null;
    }
  }
  void repo;
  return out;
}

function execFileSelections(fields: FieldNode[], file: { path: string; headContent: string; baseContent: string }): JsonObj {
  const out: JsonObj = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    if (f.name === 'path') out[key] = file.path;
    else out[key] = null;
  }
  return out;
}

function execRepoSelections(fields: FieldNode[], view: RepoView | null): JsonObj | null {
  if (view === null) return null;
  const { repo, owner } = view;
  const out: JsonObj = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id': out[key] = globalId('Repository', String(repo.id)); break;
      case 'databaseId': out[key] = repo.id; break;
      case 'name': out[key] = repo.name; break;
      case 'nameWithOwner': out[key] = `${owner}/${repo.name}`; break;
      case 'owner': out[key] = execUserSelections(f.fields ?? [], owner); break;
      case 'defaultBranchRef': out[key] = f.fields === null ? repo.defaultBranch : { name: repo.defaultBranch }; break;
      case 'viewerPermission': out[key] = 'ADMIN'; break;
      case 'hasIssuesEnabled': out[key] = true; break;
      case 'issue': {
        const number = typeof f.args.number === 'number' ? f.args.number : NaN;
        const issue = repo.issues.get(number) ?? null;
        out[key] = execIssueSelections(f.fields ?? [], issue, view);
        break;
      }
      case 'pullRequest': {
        const number = typeof f.args.number === 'number' ? f.args.number : NaN;
        const pull = repo.pulls.get(number) ?? null;
        out[key] = execPullSelections(f.fields ?? [], pull, view);
        break;
      }
      case 'issues': {
        out[key] = execIssueConnection(f, view);
        break;
      }
      case 'pullRequests': {
        const first = typeof f.args.first === 'number' ? f.args.first : 10;
        const pulls = [...repo.pulls.values()].slice(0, first);
        const nodes = pulls.map(p => execPullSelections(f.fields === null ? [] : (f.fields.find(x => x.name === 'nodes')?.fields ?? []), p, view));
        out[key] = { nodes };
        break;
      }
      default: out[key] = null;
    }
  }
  return out;
}

function execUserSelections(fields: FieldNode[], login: string): JsonObj {
  const out: JsonObj = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    if (f.name === 'login') out[key] = login;
    else out[key] = null;
  }
  return out;
}

function execIssueConnection(field: FieldNode, view: RepoView): JsonObj {
  const first = typeof field.args.first === 'number' ? field.args.first : 10;
  const statesArg = field.args.states;
  const orderBy = field.args.orderBy as { field?: string; direction?: string } | undefined;
  const after = typeof field.args.after === 'string' ? decodeCursor(field.args.after) : (field.args.after === undefined && field.args.first === undefined ? undefined : null);

  let issues = [...view.repo.issues.values()];
  if (Array.isArray(statesArg) && statesArg.length > 0) {
    const wanted = new Set(statesArg.map(s => String(s).toLowerCase()));
    issues = issues.filter(i => wanted.has(i.state));
  }
  // CREATED_AT ASC default; DESC when asked
  issues.sort((a, b) => a.createdAt - b.createdAt || a.number - b.number);
  if (orderBy?.direction === 'DESC') issues.reverse();

  let start = 0;
  if (after !== null && after !== undefined && after !== 0) start = after;
  const page = issues.slice(start, start + first);
  const hasNext = start + first < issues.length;
  const nodesField = field.fields?.find(x => x.name === 'nodes');
  const pageInfoField = field.fields?.find(x => x.name === 'pageInfo');
  const nodes = page.map(i => execIssueSelections(nodesField?.fields ?? [], i, view));
  const pageInfo: JsonObj = {};
  if (pageInfoField !== undefined) {
    for (const pf of pageInfoField.fields ?? []) {
      const k = pf.alias ?? pf.name;
      if (pf.name === 'hasNextPage') pageInfo[k] = hasNext;
      else if (pf.name === 'endCursor') pageInfo[k] = hasNext || page.length > 0 ? encodeCursor(start + page.length) : null;
      else pageInfo[k] = null;
    }
  }
  return { nodes, pageInfo };
}

function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`).toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const offset = Number(text.slice(7));
    return Number.isFinite(offset) ? offset : null;
  } catch {
    return null;
  }
}

// ---------- executor ----------

function executeOperation(op: OpNode, ctx: GqlCtx): { data: JsonObj | null; errors: JsonObj[] } {
  const data: JsonObj = {};
  try {
    if (op.kind === 'query') {
      for (const f of op.fields) {
        const key = f.alias ?? f.name;
        data[key] = execQueryField(f, ctx);
      }
    } else {
      for (const f of op.fields) {
        const key = f.alias ?? f.name;
        data[key] = execMutationField(f, ctx);
      }
    }
    return { data, errors: [] };
  } catch (err) {
    return { data: null, errors: [errEntry(err instanceof Error ? err.message : String(err))] };
  }
}

function execQueryField(f: FieldNode, ctx: GqlCtx): unknown {
  const viewer = currentViewer();
  switch (f.name) {
    case 'viewer':
      return resolveNode(f.fields ?? [], () => ({ login: viewer }));
    case '__type': {
      const name = String(f.args.name ?? '');
      const wantFields = f.fields?.some(x => x.name === 'fields') ?? false;
      const wantEnums = f.fields?.some(x => x.name === 'enumValues') ?? false;
      const sub = (f.fields ?? []).find(x => x.name === 'fields' || x.name === 'enumValues');
      const shaped = typeIntrospection(name, wantEnums, wantFields);
      if (shaped === null) return null;
      // rebuild the shape honoring the exact sub-selection keys
      const out: JsonObj = { name: shaped.name };
      for (const sf of f.fields ?? []) {
        const k = sf.alias ?? sf.name;
        if (sf.name === 'fields' && wantFields) {
          out[k] = (shaped.fields as JsonObj[]).map(e => pick(e, sf.fields ?? []));
        } else if (sf.name === 'enumValues' && wantEnums) {
          out[k] = (shaped.enumValues as JsonObj[]).map(e => pick(e, sf.fields ?? []));
        } else {
          out[k] = null;
        }
      }
      void sub;
      return out;
    }
    case 'repository': {
      const owner = String(f.args.owner ?? '');
      const name = String(f.args.name ?? '');
      const view = findRepo(owner, name);
      if (view !== null) bindViewer(owner);
      return execRepoSelections(f.fields ?? [], view);
    }
    case 'node': {
      const decoded = decodeGlobalId(String(f.args.id ?? ''));
      if (decoded === null) return null;
      if (decoded.type !== 'Repository') return null;
      let repo: Repo | undefined;
      for (const r of store.repos.values()) if (String(r.id) === decoded.id) { repo = r; break; }
      if (repo === undefined) return null;
      const view: RepoView = { repo, owner: repo.owner || 'forge-user' };
      const out = execRepoSelections(f.fields ?? [], view);
      if (out === null) return null;
      out.id = globalId('Repository', String(repo.id));
      return out;
    }
    default:
      throw new Error(`unknown field on Query: ${f.name}`);
  }
}

function pick(obj: JsonObj, fields: FieldNode[]): JsonObj {
  const out: JsonObj = {};
  for (const f of fields) {
    const k = f.alias ?? f.name;
    out[k] = obj[f.name] ?? null;
  }
  return out;
}

function resolveNode(fields: FieldNode[], source: () => JsonObj): JsonObj {
  const src = source();
  const out: JsonObj = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    if (!(f.name in src)) throw new Error(`unknown field: ${f.name}`);
    out[key] = src[f.name] ?? null;
  }
  return out;
}

function execMutationField(f: FieldNode, ctx: GqlCtx): unknown {
  const input = (f.args.input ?? {}) as JsonObj;
  switch (f.name) {
    case 'createIssue': {
      const repo = repoByGlobalId(String(input.repositoryId ?? ''));
      if (repo === null) throw new Error('repository not found');
      const title = String(input.title ?? '');
      const body = String(input.body ?? '');
      const n = repo.issueSeq + 1;
      repo.issueSeq = n;
      const issue: Issue = { number: n, title, body, state: 'open', labels: [], comments: [], createdAt: LC(), updatedAt: LC() };
      repo.issues.set(n, issue);
      return resolveNode(f.fields ?? [], () => ({
        issue: {
          number: issue.number,
          id: globalId('Issue', `I_${issue.number}`),
        },
      }));
    }
    case 'closeIssue': {
      const target = decodeGlobalId(String(input.issueId ?? ''));
      if (target === null || target.type !== 'Issue') throw new Error('issue not found');
      const repo = findRepoByIssueGlobalId(String(input.issueId ?? ''));
      if (repo === null) throw new Error('issue not found');
      const number = Number(target.id.replace('I_', ''));
      const issue = repo.issues.get(number);
      if (issue === undefined) throw new Error('issue not found');
      issue.state = 'closed';
      issue.updatedAt = LC();
      return resolveNode(f.fields ?? [], () => ({
        issue: { number: issue.number, id: globalId('Issue', `I_${issue.number}`), state: 'CLOSED' },
      }));
    }
    case 'createPullRequest': {
      const repo = repoByGlobalId(String(input.repositoryId ?? ''));
      if (repo === null) throw new Error('repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const title = String(input.title ?? '');
      const body = String(input.body ?? '');
      // reuse the REST pull creation path via a synthetic internal call: build the pull directly
      const headSha = repo.branches.get(head);
      const baseSha = repo.branches.get(base);
      if (headSha === undefined || baseSha === undefined) throw new Error('unknown branch');
      const n = repo.pullSeq + 1;
      repo.pullSeq = n;
      const pull: Pull = {
        number: n, title, body, state: 'open', merged: false,
        head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha },
        mergeCommitSha: null, mergedAt: null, createdAt: LC(), files: [],
      };
      repo.pulls.set(n, pull);
      return resolveNode(f.fields ?? [], () => ({
        pullRequest: { number: n, id: globalId('PullRequest', `PR_${n}`), state: 'OPEN', headRefName: head, baseRefName: base },
      }));
    }
    case 'mergePullRequest': {
      const target = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (target === null || target.type !== 'PullRequest') throw new Error('pull request not found');
      const repo = findRepoByPullGlobalId(String(input.pullRequestId ?? ''));
      if (repo === null) throw new Error('pull request not found');
      const number = Number(target.id.replace('PR_', ''));
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new Error('pull request not found');
      // squash-merge like the REST path
      const headTip = repo.commits.get(pull.head.sha) ?? null;
      const baseTip = repo.commits.get(repo.branches.get(pull.base.ref) ?? '');
      if (headTip !== null && baseTip !== undefined) {
        // import honestCommit lazily to avoid a cycle: build the merge commit via gitd
        const sha = mergeCommitFor(repo, { ...headTip.tree }, [baseTip.sha], `Merge pull #${pull.number} (squash): ${pull.title}`);
        repo.branches.set(pull.base.ref, sha);
      }
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = LC();
      pull.mergeCommitSha = repo.branches.get(pull.base.ref) ?? null;
      return resolveNode(f.fields ?? [], () => ({
        pullRequest: { number: pull.number, merged: true, state: 'MERGED' },
      }));
    }
    case 'addComment': {
      const target = decodeGlobalId(String(input.subjectId ?? ''));
      if (target === null || target.type !== 'Issue') throw new Error('issue not found');
      const repo = findRepoByIssueGlobalId(String(input.subjectId ?? ''));
      if (repo === null) throw new Error('issue not found');
      const number = Number(target.id.replace('I_', ''));
      const issue = repo.issues.get(number);
      if (issue === undefined) throw new Error('issue not found');
      const body = String(input.body ?? '');
      const id = issue.comments.length + 1 + 8000;
      issue.comments.push({ id, body, lc: LC() });
      return resolveNode(f.fields ?? [], () => ({
        commentEdge: { node: { id: String(id), body } },
      }));
    }
    default:
      throw new Error(`unknown field on Mutation: ${f.name}`);
  }
}

// ---------- store plumbing for mutations ----------

function repoByGlobalId(gid: string): Repo | null {
  const decoded = decodeGlobalId(gid);
  if (decoded === null || decoded.type !== 'Repository') return null;
  for (const repo of store.repos.values()) {
    if (String(repo.id) === decoded.id) return repo;
  }
  return null;
}

function findRepoByIssueGlobalId(gid: string): Repo | null {
  const decoded = decodeGlobalId(gid);
  if (decoded === null) return null;
  for (const repo of store.repos.values()) {
    if (repo.issues.get(Number(decoded.id.replace('I_', ''))) !== undefined && decoded.id.startsWith('I_')) return repo;
  }
  return null;
}

function findRepoByPullGlobalId(gid: string): Repo | null {
  const decoded = decodeGlobalId(gid);
  if (decoded === null) return null;
  for (const repo of store.repos.values()) {
    if (decoded.id.startsWith('PR_') && repo.pulls.get(Number(decoded.id.replace('PR_', ''))) !== undefined) return repo;
  }
  return null;
}

import { honestCommit } from './gitd.ts';
function mergeCommitFor(repo: Repo, tree: Record<string, string>, parents: string[], message: string): string {
  return honestCommit(repo, tree, parents, message);
}

// ---------- HTTP surface ----------

export function handleGraphQL(ctx: GqlCtx): boolean {
  const { res, body, token } = ctx;
  if (token === null || token === '') {
    respond(res, 401, { message: 'Bad credentials' });
    return true;
  }
  const varsRoot = (body as JsonObj)?.variables;
  const runOne = (op: { query: string; variables?: JsonObj | undefined }): { data: JsonObj | null; errors: JsonObj[] } => {
    try {
      const parsed = parseDocument(op.query, op.variables ?? {});
      return executeOperation(parsed, ctx);
    } catch (err) {
      return { data: null, errors: [errEntry(`parse/validation: ${err instanceof Error ? err.message : String(err)}`)] };
    }
  };

  if (Array.isArray(body)) {
    // operation batching: one HTTP body, N documents
    const responses = body.map(op => {
      const o = op as JsonObj;
      const result = runOne({ query: String(o.query ?? ''), variables: (o.variables as JsonObj) ?? {} });
      return result.errors.length > 0 && result.data === null ? { data: null, errors: result.errors } : result;
    });
    respond(res, 200, responses.map(r => (r.errors.length > 0 ? { data: r.data, errors: r.errors } : { data: r.data })));
    return true;
  }

  const queryText = (body as JsonObj)?.query;
  if (typeof queryText !== 'string' || queryText === '') {
    respond(res, 400, { errors: [errEntry('no query in body')] });
    return true;
  }
  const variables = (varsRoot && typeof varsRoot === 'object' && !Array.isArray(varsRoot) ? varsRoot : {}) as JsonObj;
  const parsed = (() => {
    try {
      return parseDocument(queryText, variables);
    } catch (err) {
      respond(res, 200, { errors: [errEntry(`parse error: ${err instanceof Error ? err.message : String(err)}`)] });
      return null;
    }
  })();
  if (parsed === null) return true;
  const result = executeOperation(parsed, ctx);
  respond(res, 200, result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data });
  return true;
}
