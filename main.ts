// forge entry lifecycle: launch the Go core (go/forge), tell the env its port, then poll until
// the trial ends. The Go core serves every surface (git smart HTTP, REST v3, GraphQL, MCP);
// this file only talks to the harness.
import { launchGoCore } from './go-serve.ts';

// where the grading env lives; without it there is nothing to register with
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// per-request cap and the backoff curve for register/done polling
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// exponential backoff from 250ms, capped at 2s, at most 8 doublings
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

// offer the bound port; 200 means we won, 409 means a first register already did (both fine)
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

// poll GET /done until the body says {done: true}; a failed poll retries
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // the env is not answering yet, or the poll timed out: poll again
    }
    await sleep(retryDelay(attempt));
  }
}

async function main(): Promise<void> {
  const { child, port } = await launchGoCore();
  // if the launcher is killed, take the core down with it instead of orphaning it
  process.once('SIGINT', () => { child.kill(); process.exit(130); });
  process.once('SIGTERM', () => { child.kill(); process.exit(143); });

  process.stdout.write(`[entry] go core listening on port ${port}\n`);
  await register(port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  child.kill();
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
