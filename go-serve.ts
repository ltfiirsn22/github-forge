// go-serve.ts — spawn the vendored Go core (go/forge) and resolve the port it bound.
// The core prints "FORGE_LISTEN <port>" on stdout first thing; this shim reads it, then the
// entry lifecycle (main.ts) registers that port with the trial env exactly as before.
//
// The binary is copied to a fresh temp dir and chmodded: web-UI uploads can lose the exec bit
// and the repo mount may be read-only.

import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Launch the Go core; resolves once it prints FORGE_LISTEN <port>. */
export async function launchGoCore(): Promise<{ child: ChildProcess; port: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-'));
  const binPath = join(dir, 'forge');
  await copyFile(new URL('./go/forge', import.meta.url), binPath);
  await chmod(binPath, 0o755);
  const child = spawn(binPath, [], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
  const port = await new Promise<number>((resolve, reject) => {
    let buffer = '';
    let settled = false;
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      const match = /^FORGE_LISTEN (\d+)$/.exec(line);
      if (match === null) {
        if (!settled) {
          settled = true;
          reject(new Error(`unexpected Go core output: ${line}`));
        }
        return;
      }
      if (!settled) {
        settled = true;
        resolve(Number(match[1]));
      }
    });
    child.once('close', (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Go core exited before listening (code ${code})`));
      }
    });
    child.once('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
  return { child, port };
}
