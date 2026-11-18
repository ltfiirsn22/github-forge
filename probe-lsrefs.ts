
import { createApp } from '/workspace/projects/github-core-clone-01-entry/app.ts';
const srv = createApp();
await new Promise((r) => srv.listen(0, r));
const port = (srv.address() as {port:number}).port;
await fetch(`http://127.0.0.1:${port}/api/v3/user/repos`, {method:'POST', headers:{authorization:'Bearer t','content-type':'application/json'}, body: JSON.stringify({name:'rr', private:true})});
await fetch(`http://127.0.0.1:${port}/api/v3/repos/forge-user/rr/contents/a.txt`, {method:'PUT', headers:{authorization:'Bearer t','content-type':'application/json'}, body: JSON.stringify({message:'m', content: Buffer.from('hi').toString('base64'), branch:'main'})});
const pkt = (s: string) => Buffer.from((Buffer.byteLength(s)+4).toString(16).padStart(4,'0') + s, 'ascii');
const body = Buffer.concat([
  pkt('command=ls-refs\n'), pkt('agent=t\n'), Buffer.from('0001','ascii'),
  pkt('peel\n'), pkt('symrefs\n'), pkt('ref-prefix refs/heads/\n'), Buffer.from('0000','ascii'),
]);
const res = await fetch(`http://127.0.0.1:${port}/forge-user/rr.git/git-upload-pack`, {method:'POST', headers:{authorization:'Bearer t','git-protocol':'version=2','content-type':'application/x-git-upload-pack-request'}, body, signal: AbortSignal.timeout(5000)});
console.log('status', res.status);
console.log(JSON.stringify(await res.text()));
process.exit(0);
