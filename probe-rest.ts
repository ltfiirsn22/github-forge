// probe-rest.ts — run the kit's real REST checks against the entry app, print each failure detail.
// Usage: node --experimental-strip-types probe-rest.ts
import { createApp } from '/workspace/projects/github-core-clone-01-entry/app.ts';
import { restChecks, restProtocolChecks } from '/workspace/projects/makefun-kit/github-core-clone-01-kit/program/env/src/checks-rest.ts';
import { buildScenario } from '/workspace/projects/makefun-kit/github-core-clone-01-kit/program/env/src/wire.ts';
import { RestClient } from '/workspace/projects/makefun-kit/github-core-clone-01-kit/program/env/src/rest-client.ts';

const srv = createApp();
await new Promise((r) => srv.listen(0, r as never));
const port = (srv.address() as { port: number }).port;
const baseUrl = `http://127.0.0.1:${port}`;
const scenario = buildScenario();
const token = 'tok';
const client = new RestClient({ baseUrl, token });
const anon = new RestClient({ baseUrl, token: null });

const specs = [...restChecks(), ...restProtocolChecks()];
let pass = 0;
const fails: string[] = [];
for (const spec of specs) {
  const context = {
    baseUrl, token, scenario,
    deadlineMs: Date.now() + 30_000,
    timeoutMs: 30_000,
    signal: undefined,
    log: () => {},
  } as never;
  try {
    const result = await (spec as { fn: (c: never) => Promise<{ ok: boolean; detail: string }> }).fn(context);
    if (result.ok) pass += 1; else fails.push(`${spec.id}: ${result.detail}`);
  } catch (err) {
    fails.push(`${spec.id}: threw ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`PASS ${pass} / ${specs.length}`);
for (const f of fails) console.log('FAIL', f);
srv.close();
process.exit(0);
