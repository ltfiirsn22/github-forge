
import { createApp } from '/workspace/projects/github-core-clone-01-entry/app.ts';
const srv = createApp();
await new Promise((r) => srv.listen(0, r));
const port = (srv.address() as {port:number}).port;
const B = `http://127.0.0.1:${port}`;
const H = {authorization:'Bearer tok','content-type':'application/json'};
const c1 = await fetch(`${B}/api/v3/user/repos`, {method:'POST', headers:H, body: JSON.stringify({name:'amber-thistle', private:false})});
const g1 = await fetch(`${B}/api/v3/repos/adaiversen/amber-thistle`, {headers:H});
console.log('POST', c1.status, 'GET', g1.status);
const q = await fetch(`${B}/api/graphql`, {method:'POST', headers:H, body: JSON.stringify({query:'query V { viewer { login } }'})});
console.log('gql', JSON.stringify(await q.json()));
process.exit(0);
