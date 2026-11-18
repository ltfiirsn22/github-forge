# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ltfiirsn22/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ltfiirsn22/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one process: git smart HTTP (upload-pack protocol v2, receive-pack v0), REST v3, GraphQL v4 and MCP served from one in-memory store, with no git binary, no packages and no outside services — Node.js standard library only.

## Surfaces

- **Git smart HTTP** — clone, fetch and push (`/{owner}/{repo}.git/info/refs`, `git-upload-pack`, `git-receive-pack`), protocol v2 and v0, packfiles read and written from scratch (ofs/ref deltas included)
- **REST v3** — repositories, branches, issues, labels, pulls, contents, comments (`/api/v3/...`)
- **GraphQL v4** — the document shapes `gh` and `github-mcp-server` send: viewer, repository, issues (states, ordering, cursor pagination), pulls, mutations (createIssue, closeIssue, createPullRequest, mergePullRequest, addComment), `__type` introspection, operation batching
- **MCP** — Streamable HTTP at `/mcp`: `server/discover`, `initialize`, `tools/list`, `tools/call` with six GitHub-shaped tools

## Run it

```sh
node --experimental-strip-types main.ts
```

Node 22+ strips the TypeScript on its own; there is nothing to install and no network needed. The server binds an ephemeral port and registers it with the grading environment.

## Design notes

- Deterministic by construction: no clock reads, no random — ids come from counters and a logical clock, so two runs leave byte-identical state exports
- Pack entry walk uses a binary search over the zlib stream end (inflateSync completes only on a full stream), O(log L) inflates per entry
- REST-created objects carry real git oids (sha1 of content), so pushes and clones round-trip verifiable object graphs
- Layout: `main.ts` (lifecycle), `app.ts` (server + routing), `store.ts` (state), `rest.ts`, `gitwire.ts` + `gitobjects.ts` + `gitd.ts` (git transport), `graphql.ts`, `mcp.ts`

---

Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards
