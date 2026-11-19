// probe-mount.mjs — inside the exact trial sandbox: can we exec from the /bot mount directly,
// and what does fs.stat see for /bot/go/forge? Prints evidence, exits 0.
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

const info = await stat('/bot/go/forge');
console.log('stat mode:', (info.mode & 0o777).toString(8), 'size:', info.size);

const child = spawn('/bot/go/forge', [], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
child.on('error', (e) => { console.log('spawn err:', e.message); process.exit(0); });
child.stdout.on('data', (d) => { console.log('spawn ok:', String(d).split('\n')[0]); child.kill(); process.exit(0); });
setTimeout(() => { child.kill('SIGKILL'); console.log('timeout'); process.exit(0); }, 3000);
