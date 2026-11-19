// probe-entry.mjs — replicate the trial sandbox exactly (read-only repo, tmpfs /tmp, nobody uid,
// cap-drop, no-new-privileges) and try both spawn paths; prints which one works.
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoBin = fileURLToPath(new URL('./go/forge', import.meta.url));

function trySpawn(label, bin) {
  return new Promise((resolve) => {
    const child = spawn(bin, [], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
    let done = false;
    child.on('error', (err) => { if (!done) { done = true; console.log(label, 'ERR', err.message); resolve(false); } });
    child.stdout.on('data', (d) => {
      const line = String(d).split('\n')[0].trim();
      if (/^FORGE_LISTEN \d+$/.test(line)) { if (!done) { done = true; console.log(label, 'OK', line); child.kill(); resolve(true); } }
    });
    setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); console.log(label, 'TIMEOUT'); resolve(false); } }, 3000);
  });
}

const repoOk = await trySpawn('repo-direct', repoBin);
if (!repoOk) {
  const dir = await mkdtemp(join(tmpdir(), 'forge-'));
  const binPath = join(dir, 'forge');
  await copyFile(repoBin, binPath);
  await chmod(binPath, 0o755);
  const tmpOk = await trySpawn('tmp-copy', binPath);
  console.log('tmp-ok', tmpOk);
}
process.exit(0);
