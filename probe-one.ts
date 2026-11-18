
import { createApp } from '/workspace/projects/github-core-clone-01-entry/app.ts';
import { GIT_CHECKS } from '/workspace/projects/makefun-kit/github-core-clone-01-kit/program/env/src/checks-git.ts';
import { buildScenario } from '/workspace/projects/makefun-kit/github-core-clone-01-kit/program/env/src/wire.ts';
const srv = createApp();
await new Promise((r) => srv.listen(0, r));
const port = (srv.address() as {port:number}).port;
const context: any = {
  baseUrl: `http://127.0.0.1:${port}`,
  token: 'tok',
  scenario: buildScenario(),
  deadlineMs: Date.now() + 120_000,
  timeoutMs: 60_000,
  log: () => {},
};
const spec = GIT_CHECKS.find((s: any) => s.id === 'git.clone-annotated-tag')!;
const result = await (spec as any).fn(context);
console.log('RESULT', JSON.stringify(result).slice(0, 400));
process.exit(0);
