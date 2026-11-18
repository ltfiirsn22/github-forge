
import { createApp } from '/workspace/projects/github-core-clone-01-entry/app.ts';
import { createGitFixture } from '/workspace/projects/makefun-kit/github-core-clone-01-kit/program/env/src/main.ts';
import { configureGraphQLGit } from '/workspace/projects/makefun-kit/github-core-clone-01-kit/program/env/src/checks-graphql.ts';
const srv = createApp();
await new Promise((r) => srv.listen(0, r));
const port = (srv.address() as {port:number}).port;
const B = `http://127.0.0.1:${port}`;
const H = {authorization:'Bearer tok','content-type':'application/json'};
await fetch(`${B}/api/v3/user/repos`, {method:'POST', headers:H, body: JSON.stringify({name:'pfr', private:false})});
await fetch(`${B}/api/v3/repos/adaiversen/pfr`, {headers:H});
const fx = createGitFixture({ baseUrl: B, token: 'tok', signal: AbortSignal.timeout(60000), log: ()=>{} });
configureGraphQLGit(fx);
const push = async (branch: string, from: string | undefined, path: string, content: string, msg: string) =>
  console.log('push', branch, await fx.pushBranch({ owner: 'adaiversen', repo: 'pfr', branch, from, path, content, message: msg }));
await push('main', undefined, 'README.md', '# base\n', 'base');
await push('feat/x', 'main', 'config/token.css', 'body\n', 'add css');
const pr = await fetch(`${B}/api/v3/repos/adaiversen/pfr/pulls`, {method:'POST', headers:H, body: JSON.stringify({title:'t', body:'b', head:'feat/x', base:'main'})});
const prj = await pr.json();
console.log('PR', pr.status, JSON.stringify(prj.files));
const q = await fetch(`${B}/api/graphql`, {method:'POST', headers:H, body: JSON.stringify({query:'query Q($o: String!, $n: String!, $num: Int!) { repository(owner: $o, name: $n) { pullRequest(number: $num) { number files(first: 10) { nodes { path } } } } }', variables:{o:'adaiversen', n:'pfr', num:1}})});
console.log('gql', JSON.stringify(await q.json()));
process.exit(0);
