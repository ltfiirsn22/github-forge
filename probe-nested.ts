
import { createApp } from '/workspace/projects/github-core-clone-01-entry/app.ts';
const srv = createApp();
await new Promise((r) => srv.listen(0, r));
const port = (srv.address() as {port:number}).port;
const B = `http://127.0.0.1:${port}`;
const H = {authorization:'Bearer t','content-type':'application/json'};
await fetch(`${B}/api/v3/user/repos`, {method:'POST', headers:H, body: JSON.stringify({name:'nr', private:true})});
await fetch(`${B}/api/v3/repos/forge-user/nr/contents/dir/sub/file.txt`, {method:'PUT', headers:H, body: JSON.stringify({message:'m', content: Buffer.from('hello nested').toString('base64'), branch:'main'})});
const pkt = (s: string) => Buffer.from((Buffer.byteLength(s)+4).toString(16).padStart(4,'0') + s, 'ascii');
// ls-refs to get tip
const lsBody = Buffer.concat([pkt('command=ls-refs\n'), pkt('agent=t\n'), Buffer.from('0001','ascii'), pkt('symrefs\n'), Buffer.from('0000','ascii')]);
const ls = await fetch(`${B}/forge-user/nr.git/git-upload-pack`, {method:'POST', headers:{...H,'git-protocol':'version=2','content-type':'application/x-git-upload-pack-request'}, body: lsBody, signal: AbortSignal.timeout(5000)});
const lsText = await ls.text();
console.log('lsrefs', JSON.stringify(lsText));
const tip = /([0-9a-f]{40}) refs\/heads\/main/.exec(lsText)![1];
// fetch the tip with deepen 1
const fBody = Buffer.concat([pkt('command=fetch\n'), pkt('agent=t\n'), Buffer.from('0001','ascii'),
  pkt(`want ${tip}\n`), pkt('deepen 1\n'), Buffer.from('0000','ascii')]);
const f = await fetch(`${B}/forge-user/nr.git/git-upload-pack`, {method:'POST', headers:{...H,'git-protocol':'version=2','content-type':'application/x-git-upload-pack-request'}, body: fBody, signal: AbortSignal.timeout(5000)});
const buf = Buffer.from(await f.arrayBuffer());
// walk pkt lines, print non-binary lines; find packfile section, readPack it
const { readPack } = await import('/workspace/projects/github-core-clone-01-entry/gitobjects.ts');
let off = 0; const oids: string[] = [];
while (off + 4 <= buf.length) {
  const len = parseInt(buf.subarray(off, off+4).toString('ascii'), 16);
  if (!Number.isFinite(len) || len < 4) { off += 4; continue; }
  const chunk = buf.subarray(off+4, off+len);
  off += len;
  if (chunk[0] === 1) {
    // sideband data: accumulate
    const idx = chunk.indexOf(Buffer.from('PACK'));
    if (idx >= 0) {
      const pack = chunk.subarray(idx);
      try { for (const [oid] of readPack(pack)) oids.push(oid); } catch (e) { console.log('pack parse err', (e as Error).message); }
    }
  } else if (chunk[0] !== 0 && chunk[0] !== 3) {
    console.log('line:', JSON.stringify(chunk.toString('utf8').slice(0,80)));
  }
}
console.log('delivered oids:', oids.length, oids);
process.exit(0);
