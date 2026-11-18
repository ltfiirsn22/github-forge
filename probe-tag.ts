
import { createApp } from '/workspace/projects/github-core-clone-01-entry/app.ts';
const srv = createApp();
await new Promise((r) => srv.listen(0, r));
const port = (srv.address() as {port:number}).port;
const B = `http://127.0.0.1:${port}`;
const H = {authorization:'Bearer t','content-type':'application/json'};
await fetch(`${B}/api/v3/user/repos`, {method:'POST', headers:H, body: JSON.stringify({name:'tr', private:true})});
await fetch(`${B}/api/v3/repos/forge-user/tr/contents/a.txt`, {method:'PUT', headers:H, body: JSON.stringify({message:'m', content: Buffer.from('tagged').toString('base64'), branch:'main'})});
// create annotated tag via REST? rest.ts has no tags API? Use git push of a tag instead: build a tag object + pack... complex. Instead check what the suite does: prepareRepo probably pushes tag via git-client. Emulate: push tag object with receive-pack.
// Simpler: check ls-refs advertisement after creating tag through... skip creation; just verify fetch of a tag want fails/works using synthetic: not possible without tag.
process.exit(0);
