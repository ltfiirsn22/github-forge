// go-serve.ts — spawn the vendored Go core (go/forge) and resolve the port it bound.
// The core prints "FORGE_LISTEN <port>" on stdout first thing; this shim reads it, then the
// entry lifecycle (main.ts) registers that port with the trial env exactly as before.
//
// Exec order: straight from the repository first — a read-only bind mount still allows exec,
// and the committed binary carries mode 755. Only on EACCES (a mount flagged noexec, or an
// upload that lost the exec bit) do we copy to a fresh temp dir, chmod 755 and retry there;
// the tmpfs copy only helps when the sandbox's /tmp is NOT flagged noexec.

import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve once the Go core printed FORGE_LISTEN <port>. */
function readPort(child: ChildProcess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
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
}

/** Launch the Go core; resolves once it printed FORGE_LISTEN <port>. */
export async function launchGoCore(): Promise<{ child: ChildProcess; port: number }> {
  const repoBin = fileURLToPath(new URL('./go/forge', import.meta.url)); // spawn needs a path, not a URL
  // 1) straight from the repository mount
  try {
    const child = spawn(repoBin, [], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
    const port = await readPort(child);
    return { child, port };
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('EACCES')) throw err;
  }
  // 2) EACCES: the mount is noexec or the bit was lost — copy out and chmod
  const dir = await mkdtemp(join(tmpdir(), 'forge-'));
  const binPath = join(dir, 'forge');
  await copyFile(repoBin, binPath);
  await chmod(binPath, 0o755);
  const child = spawn(binPath, [], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
  const port = await readPort(child);
  return { child, port };
}
