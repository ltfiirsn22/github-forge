
import { createApp } from '/workspace/projects/github-core-clone-01-entry/app.ts';
import { store } from '/workspace/projects/github-core-clone-01-entry/store.ts';
const srv = createApp();
await new Promise((r) => srv.listen(0, r));
const port = (srv.address() as {port:number}).port;
const B = `http://127.0.0.1:${port}`;
const H = {authorization:'Bearer t','content-type':'application/json'};
await fetch(`${B}/api/v3/user/repos`, {method:'POST', headers:H, body: JSON.stringify({name:'nr2', private:true})});
await fetch(`${B}/api/v3/repos/forge-user/nr2/contents/dir/sub/file.txt`, {method:'PUT', headers:H, body: JSON.stringify({message:'m', content: Buffer.from('hello nested').toString('base64'), branch:'main'})});
const repo = [...store.values()].find((r: any) => r.name === 'nr2');
console.log('blobs map keys:', [...(repo as any).blobs.keys()]);
console.log('tree:', (repo as any).commits.get([...(repo as any).branches.values()][0])?.tree);
process.exit(0);
