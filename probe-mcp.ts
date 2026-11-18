// probe-mcp.ts — run the kit's real MCP checks against the entry server.
import { createApp } from '/workspace/projects/github-core-clone-01-entry/app.ts';
import { MCP_CHECKS } from '/workspace/projects/makefun-kit/github-core-clone-01-kit/program/env/src/checks-mcp.ts';
import { buildScenario } from '/workspace/projects/makefun-kit/github-core-clone-01-kit/program/env/src/wire.ts';

const srv = createApp();
await new Promise((r) => srv.listen(0, r as never));
const port = (srv.address() as { port: number }).port;
const baseUrl = `http://127.0.0.1:${port}`;
const scenario = buildScenario();
const token = 'tok';

// The graded run binds the viewer through earlier groups' owner-addressed REST reads.
await fetch(`${baseUrl}/api/v3/repos/${scenario.viewer.login}/${scenario.repos[0].name}`, {
  headers: { authorization: `Bearer ${token}` },
});

const context: Record<string, unknown> = {
  baseUrl,
  token,
  scenario,
  deadlineMs: Date.now() + 300_000,
  timeoutMs: 60_000,
  signal: AbortSignal.timeout(240_000),
  log: () => {},
};

let pass = 0;
const fails: string[] = [];
for (const spec of MCP_CHECKS) {
  try {
    const result = await (spec as unknown as { fn: (c: never) => Promise<{ ok: boolean; detail: string }> }).fn(context as never);
    if (result.ok) pass += 1;
    else fails.push(`${spec.id}: ${result.detail.slice(0, 200)}`);
  } catch (err) {
    fails.push(`${spec.id}: threw ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`PASS ${pass} / ${MCP_CHECKS.length}`);
for (const f of fails) console.log('FAIL', f);
srv.close();
process.exit(fails.length === 0 ? 0 : 1);
