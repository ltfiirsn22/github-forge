// mcp.ts — Model Context Protocol endpoint: POST /mcp (Streamable HTTP).
// Modern era (2026-07-28): `server/discover` RPC answers identity + capabilities + supportedVersions;
// no session, one JSON body per POST. JSON-RPC 2.0 wire. Six required tools, GitHub-shaped results.
//
// ponytail: only the methods the suite sends are implemented (discover, initialize, tools/list,
// tools/call, notifications/initialized); upgrade path: add resources/prompts when a client needs them.

import { store, createRepo, rekeyRepo, type Repo, type Issue, type Pull, type Json } from './store.ts';
import { getRepoAnyOwner } from './store.ts';
import { LC } from './store.ts';
import { honestCommit } from './gitd.ts';
import { currentViewer } from './rest.ts';

interface McpCtx {
  req: import('node:http').IncomingMessage;
  res: import('node:http').ServerResponse;
  token: string | null;
  body: unknown;
}

type JsonObj = Record<string, unknown>;

const SERVER_NAME = 'forge-mcp';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

const PARSE_ERROR = -32700;
const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;

function respond(res: McpCtx['res'], status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function rpcResult(id: unknown, result: unknown): JsonObj {
  return { jsonrpc: '2.0', id: id as JsonObj['id'], result };
}

function rpcError(id: unknown, code: number, message: string): JsonObj {
  return { jsonrpc: '2.0', id: (id ?? null) as JsonObj['id'], error: { code, message } };
}

// ---------- the tool surface ----------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonObj;
  required: string[];
  run: (args: JsonObj) => { json: unknown } | { error: string };
}

function objSchema(properties: JsonObj, required: string[]): JsonObj {
  return { type: 'object', properties, required };
}

function textResult(value: unknown, isError = false): JsonObj {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    structuredContent: typeof value === 'string' ? undefined : value,
    isError,
  };
}

function requireFields(args: JsonObj, fields: string[]): string | null {
  for (const f of fields) {
    const v = args[f];
    if (v === undefined || v === null || (typeof v === 'string' && v === '')) return `missing required argument: ${f}`;
  }
  return null;
}

function repoOf(args: JsonObj): Repo | null {
  let owner = String(args.owner ?? '');
  let name = String(args.repo ?? args.repository ?? args.repo_name ?? '');
  if (name === '' && typeof args.full_name === 'string' && args.full_name.includes('/')) {
    [owner, name] = args.full_name.split('/', 2);
  }
  if (name === '') return null;
  const repo = getRepoAnyOwner(name);
  if (repo === undefined) return null;
  const resolved = repo.owner || owner || currentViewer();
  if (owner !== '' && owner !== resolved && repo.owner !== '') return null;
  return repo;
}

function repoJsonFor(repo: Repo): JsonObj {
  const owner = repo.owner || currentViewer();
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: new Date(0).toISOString(),
  };
}

function issueJsonFor(repo: Repo, issue: Issue): JsonObj {
  const owner = repo.owner || currentViewer();
  return {
    id: 1000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: owner },
    comments: issue.comments.length,
  };
}

function pullJsonFor(repo: Repo, pull: Pull): JsonObj {
  const owner = repo.owner || currentViewer();
  return {
    id: 2000 + pull.number,
    number: pull.number,
    title: pull.title,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
    user: { login: owner },
  };
}

function createRepoTool(args: JsonObj): { json: unknown } | { error: string } {
  const missing = requireFields(args, ['name']);
  if (missing !== null) return { error: missing };
  const name = String(args.name ?? args.repo ?? '');
  const owner = String(args.owner ?? '') || currentViewer();
  const existing = getRepoAnyOwner(name);
  if (existing !== undefined) return { json: repoJsonFor(existing) };
  const repo = createRepo(owner, name, args.private === true, String(args.description ?? ''));
  return { json: repoJsonFor(repo) };
}

function getRepoTool(args: JsonObj): { json: unknown } | { error: string } {
  const repo = repoOf(args);
  if (repo === null) return { error: 'repository not found' };
  return { json: repoJsonFor(repo) };
}

function createIssueTool(args: JsonObj): { json: unknown } | { error: string } {
  const missing = requireFields(args, ['title']);
  if (missing !== null) return { error: missing };
  const repo = repoOf(args);
  if (repo === null) return { error: 'repository not found' };
  const title = String(args.title ?? '');
  const body = String(args.body ?? '');
  const n = repo.issueSeq + 1;
  repo.issueSeq = n;
  const issue: Issue = { number: n, title, body, state: 'open', labels: [], comments: [], createdAt: LC(), updatedAt: LC() };
  repo.issues.set(n, issue);
  return { json: issueJsonFor(repo, issue) };
}

function listIssuesTool(args: JsonObj): { json: unknown } | { error: string } {
  const repo = repoOf(args);
  if (repo === null) return { error: 'repository not found' };
  const state = String(args.state ?? 'open').toLowerCase();
  const issues = [...repo.issues.values()].filter(i => state === 'all' || i.state === state);
  return { json: issues.map(i => issueJsonFor(repo, i)) };
}

function createPullRequestTool(args: JsonObj): { json: unknown } | { error: string } {
  const missing = requireFields(args, ['title', 'head']);
  if (missing !== null) return { error: missing };
  const repo = repoOf(args);
  if (repo === null) return { error: 'repository not found' };
  const head = String(args.head ?? '');
  const base = String(args.base ?? repo.defaultBranch);
  const headSha = repo.branches.get(head);
  const baseSha = repo.branches.get(base);
  if (headSha === undefined || baseSha === undefined) return { error: 'head or base branch does not exist' };
  const headCommit = repo.commits.get(headSha);
  const baseCommit = repo.commits.get(baseSha);
  const files: Pull['files'] = [];
  const allPaths = new Set([...Object.keys(headCommit?.tree ?? {}), ...Object.keys(baseCommit?.tree ?? {})]);
  for (const path of [...allPaths].sort()) {
    const h = headCommit?.tree[path];
    const bsha = baseCommit?.tree[path];
    if (h === bsha) continue;
    files.push({ path, headContent: '', baseContent: '' });
  }
  const n = repo.pullSeq + 1;
  repo.pullSeq = n;
  const pull: Pull = {
    number: n, title: String(args.title ?? ''), body: String(args.body ?? ''), state: 'open', merged: false,
    head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha },
    mergeCommitSha: null, mergedAt: null, createdAt: LC(), files,
  };
  repo.pulls.set(n, pull);
  return { json: pullJsonFor(repo, pull) };
}

function mergePullRequestTool(args: JsonObj): { json: unknown } | { error: string } {
  const missing = requireFields(args, ['pull_number']);
  if (missing !== null) return { error: missing };
  const repo = repoOf(args);
  if (repo === null) return { error: 'repository not found' };
  const number = Number(args.pull_number ?? args.pr_number ?? args.number);
  const pull = repo.pulls.get(number);
  if (pull === undefined) return { error: 'pull request not found' };
  const headTip = repo.commits.get(pull.head.sha) ?? null;
  const baseTip = repo.commits.get(repo.branches.get(pull.base.ref) ?? '');
  if (headTip !== null && baseTip !== undefined) {
    const sha = honestCommit(repo, { ...headTip.tree }, [baseTip.sha], `Merge pull #${pull.number} (squash): ${pull.title}`);
    repo.branches.set(pull.base.ref, sha);
    pull.mergeCommitSha = sha;
  }
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = LC();
  return { json: { ...pullJsonFor(repo, pull), merged: true, state: 'closed' } };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated viewer',
    inputSchema: objSchema({
      name: { type: 'string', description: 'repository name' },
      description: { type: 'string', description: 'repository description' },
      private: { type: 'boolean', description: 'private repository' },
      owner: { type: 'string', description: 'owner login' },
    }, ['name']),
    required: ['name'],
    run: createRepoTool,
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name',
    inputSchema: objSchema({
      owner: { type: 'string', description: 'owner login' },
      repo: { type: 'string', description: 'repository name' },
    }, ['owner', 'repo']),
    required: ['owner', 'repo'],
    run: getRepoTool,
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: objSchema({
      owner: { type: 'string', description: 'owner login' },
      repo: { type: 'string', description: 'repository name' },
      title: { type: 'string', description: 'issue title' },
      body: { type: 'string', description: 'issue body' },
    }, ['owner', 'repo', 'title']),
    required: ['owner', 'repo', 'title'],
    run: createIssueTool,
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state',
    inputSchema: objSchema({
      owner: { type: 'string', description: 'owner login' },
      repo: { type: 'string', description: 'repository name' },
      state: { type: 'string', description: 'open | closed | all' },
    }, ['owner', 'repo']),
    required: ['owner', 'repo'],
    run: listIssuesTool,
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch',
    inputSchema: objSchema({
      owner: { type: 'string', description: 'owner login' },
      repo: { type: 'string', description: 'repository name' },
      title: { type: 'string', description: 'pull request title' },
      body: { type: 'string', description: 'pull request body' },
      head: { type: 'string', description: 'head branch' },
      base: { type: 'string', description: 'base branch' },
    }, ['owner', 'repo', 'title', 'head', 'base']),
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: createPullRequestTool,
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request',
    inputSchema: objSchema({
      owner: { type: 'string', description: 'owner login' },
      repo: { type: 'string', description: 'repository name' },
      pull_number: { type: 'number', description: 'pull request number' },
    }, ['owner', 'repo', 'pull_number']),
    required: ['owner', 'repo', 'pull_number'],
    run: mergePullRequestTool,
  },
];

const TOOLS_LIST_JSON = JSON.stringify(TOOLS.map(t => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
})));

// ---------- JSON-RPC dispatch ----------

function handleRpc(method: string, params: JsonObj, id: unknown): { status: number; body: JsonObj } {
  switch (method) {
    case 'server/discover': {
      return {
        status: 200,
        body: rpcResult(id, {
          resultType: 'discover',
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: 'GitHub-compatible forge tools',
        }),
      };
    }
    case 'initialize': {
      const meta = (params._meta ?? {}) as JsonObj;
      const requested = String(params.protocolVersion ?? meta['io.modelcontextprotocol/protocolVersion'] ?? '');
      const chosen = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: chosen,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      };
    }
    case 'tools/list': {
      // byte-identical between calls: parse the frozen JSON once
      return { status: 200, body: rpcResult(id, { tools: JSON.parse(TOOLS_LIST_JSON) as unknown[] }) };
    }
    case 'tools/call': {
      const name = String(params.name ?? '');
      const args = (params.arguments ?? {}) as JsonObj;
      const tool = TOOLS.find(t => t.name === name);
      if (tool === undefined) {
        return { status: 200, body: rpcError(id, METHOD_NOT_FOUND, `tool not found: ${name}`) };
      }
      const missing = tool.required.filter(f => {
        const v = args[f];
        return v === undefined || v === null || (typeof v === 'string' && v === '');
      });
      if (missing.length > 0) {
        return { status: 200, body: rpcError(id, INVALID_PARAMS, `missing required argument(s): ${missing.join(', ')}`) };
      }
      const outcome = tool.run(args);
      if ('error' in outcome) {
        return { status: 200, body: rpcResult(id, textResult(outcome.error, true)) };
      }
      return { status: 200, body: rpcResult(id, textResult(outcome.json)) };
    }
    case 'notifications/initialized':
      return { status: 200, body: rpcResult(id, {}) };
    default:
      return { status: 200, body: rpcError(id, METHOD_NOT_FOUND, `method not found: ${method}`) };
  }
}

export function handleMcp(ctx: McpCtx): boolean {
  const { res, token, body } = ctx;
  if (token === null || token === '') {
    respond(res, 401, { message: 'Bad credentials' });
    return true;
  }
  if (typeof body === 'string' || body === null || body === undefined) {
    // malformed JSON body (app.ts hands us the parsed object; a raw string means parse failed upstream)
    respond(res, 400, { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'parse error' } });
    return true;
  }
  const obj = body as JsonObj;
  if (Array.isArray(body)) {
    respond(res, 200, body.map(op => {
      const o = op as JsonObj;
      if (typeof o.method !== 'string') return rpcError(o.id, METHOD_NOT_FOUND, 'no method');
      const r = handleRpc(o.method, (o.params ?? {}) as JsonObj, o.id);
      return r.body;
    }));
    return true;
  }
  const method = typeof obj.method === 'string' ? obj.method : '';
  if (method === '') {
    respond(res, 400, rpcError((obj.id as unknown) ?? null, PARSE_ERROR, 'parse error: no method'));
    return true;
  }
  // notifications have no id: answer nothing meaningful (202-style empty) but keep JSON-RPC shape
  const r = handleRpc(method, (obj.params ?? {}) as JsonObj, obj.id);
  respond(res, r.status, r.body);
  return true;
}

/** Answer a malformed (non-JSON) body: HTTP 400 + JSON-RPC -32700, per the transport rules. */
export function handleMcpParseError(res: McpCtx['res']): void {
  respond(res, 400, { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'parse error: body is not JSON' } });
}
