
import { createApp } from '/workspace/projects/github-core-clone-01-entry/app.ts';
import { store } from '/workspace/projects/github-core-clone-01-entry/store.ts';
const srv = createApp();
await new Promise((r) => srv.listen(0, r));
const port = (srv.address() as {port:number}).port;
const B = `http://127.0.0.1:${port}`;
const H = {authorization:'Bearer t','content-type':'application/json'};
await fetch(`${B}/api/v3/user/repos`, {method:'POST', headers:H, body: JSON.stringify({name:'hr', private:true})});
await fetch(`${B}/api/v3/repos/forge-user/hr/contents/a.txt`, {method:'PUT', headers:H, body: JSON.stringify({message:'m', content: Buffer.from('hello flat').toString('base64'), branch:'main'})});
const repo: any = [...(store as any).repos.values()].find((r: any) => r.name === 'hr');
console.log('branches:', [...repo.branches.entries()]);
console.log('commit tree:', repo.commits.get([...repo.branches.values()][0])?.tree);
// Now use gitd's internal blobs() indirectly: attempt a fetch and print delivered oids
const pkt = (s: string) => Buffer.from((Buffer.byteLength(s)+4).toString(16).padStart(4,'0') + s, 'ascii');
const tip = [...repo.branches.values()][0];
const fBody = Buffer.concat([pkt('command=fetch\n'), pkt('agent=t\n'), Buffer.from('0001','ascii'), pkt(`want ${tip}\n`), Buffer.from('0000','ascii')]);
const f = await fetch(`${B}/forge-user/hr.git/git-upload-pack`, {method:'POST', headers:{...H,'git-protocol':'version=2','content-type':'application/x-git-upload-pack-request'}, body: fBody, signal: AbortSignal.timeout(5000)});
const buf = Buffer.from(await f.arrayBuffer());
const { readPack } = await import('/workspace/projects/github-core-clone-01-entry/gitobjects.ts');
let off = 0; const oids: string[] = [];
while (off + 4 <= buf.length) {
  const len = parseInt(buf.subarray(off, off+4).toString('ascii'), 16);
  if (!Number.isFinite(len) || len < 4) { off += 4; continue; }
  const chunk = buf.subarray(off+4, off+len);
  off += len;
  if (chunk[0] === 1) {
    const idx = chunk.indexOf(Buffer.from('PACK'));
    if (idx >= 0) { try { for (const [oid] of readPack(chunk.subarray(idx))) oids.push(oid); } catch (e) { console.log('packerr', (e as Error).message); } }
  }
}
console.log('delivered:', oids);
const { createHash } = await import('node:crypto');
const want = createHash('sha1').update(Buffer.concat([Buffer.from('blob 10\u0000'), Buffer.from('hello flat')])).digest('hex');
console.log('honest blob oid expected:', want);
process.exit(0);
