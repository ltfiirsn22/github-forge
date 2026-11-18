
import { createApp } from '/workspace/projects/github-core-clone-01-entry/app.ts';
import { createGitFixture } from '/workspace/projects/makefun-kit/github-core-clone-01-kit/program/env/src/main.ts';
import { GitClient } from '/workspace/projects/makefun-kit/github-core-clone-01-kit/program/env/src/git-client.ts';

const srv = createApp();
await new Promise((r) => srv.listen(0, r));
const port = (srv.address() as {port:number}).port;
const B = `http://127.0.0.1:${port}`;
const H = {authorization:'Bearer tok','content-type':'application/json'};

// --- push workload: 200 sequential 1KiB pushes ---
await fetch(`${B}/api/v3/user/repos`, {method:'POST', headers:H, body: JSON.stringify({name:'bench', private:false})});
await fetch(`${B}/api/v3/repos/adaiversen/bench`, {headers:H});
const fx = createGitFixture({ baseUrl: B, token: 'tok', signal: AbortSignal.timeout(180000), log: ()=>{} });
const t0 = performance.now();
for (let i = 0; i < 200; i++) {
  const d = await fx.pushBranch({ owner: 'adaiversen', repo: 'bench', branch: 'main', from: i===0?undefined:'main', path: `f${i}.txt`, content: 'x'.repeat(1024), message: `c${i}` });
  if (d !== null) { console.log('push fail', i, d); break; }
}
const pushMs = performance.now() - t0;
console.log(`push: 200 in ${pushMs.toFixed(0)}ms (median-ish avg ${(pushMs/200).toFixed(2)}ms)`);

// --- clone workload: 50 concurrent shallow clones depth-1 ---
const client = new GitClient({ baseUrl: B, token: 'tok', timeoutMs: 60000 } as never);
const t1 = performance.now();
await Promise.all(Array.from({length:50}, () => client.clone('adaiversen', 'bench', { depth: 1, signal: AbortSignal.timeout(60000) })));
console.log(`clone: 50 concurrent depth1 in ${(performance.now()-t1).toFixed(0)}ms (per clone ${((performance.now()-t1)/50).toFixed(1)}ms)`);

// --- read workload: 2000 sequential GET issue ---
for (let i=0;i<3;i++) await fetch(`${B}/api/v3/repos/adaiversen/bench/issues`, {method:'POST', headers:H, body: JSON.stringify({title:`t${i}`, body:'b'})});
const t2 = performance.now();
for (let i=0;i<2000;i++) { const r = await fetch(`${B}/api/v3/repos/adaiversen/bench/issues/1`, {headers:{authorization:'Bearer tok'}}); await r.arrayBuffer(); }
console.log(`read: 2000 GET in ${(performance.now()-t2).toFixed(0)}ms`);

// --- write workload: 200 sequential POST issue ---
const t3 = performance.now();
for (let i=0;i<200;i++) { const r = await fetch(`${B}/api/v3/repos/adaiversen/bench/issues`, {method:'POST', headers:H, body: JSON.stringify({title:`w${i}`, body:'b'})}); await r.arrayBuffer(); }
console.log(`write: 200 POST in ${(performance.now()-t3).toFixed(0)}ms`);
process.exit(0);
