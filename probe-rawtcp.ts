
import net from 'node:net';
import http from 'node:http';
// http server
const hs = http.createServer((req,res)=>{ res.writeHead(200,{'content-type':'application/json'}); res.end('{"ok":true}\n'); });
await new Promise(r=>hs.listen(0,r));
const hp = hs.address().port;
// raw server
const rs = net.createServer((sock)=>{
  sock.on('data', (chunk)=>{
    sock.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\n\r\n{"ok":true}\n');
  });
});
await new Promise(r=>rs.listen(0,r));
const rp = rs.address().port;
// benchmark: 2000 keep-alive GET via one socket, node:http target
function benchRaw(port, label){
  return new Promise((resolve)=>{
    const sock = net.connect(port, '127.0.0.1');
    const req = 'GET /x HTTP/1.1\r\nHost: a\r\nAuthorization: Bearer t\r\n\r\n';
    let buf = ''; let n = 0; const t0 = performance.now();
    sock.on('data', (c)=>{ buf += c.toString(); while (buf.includes('{"ok":true}\n')) { buf = buf.slice(buf.indexOf('{"ok":true}\n')+11); n++; if (n>=2000) { sock.destroy(); resolve(performance.now()-t0); } } });
    sock.on('connect', ()=>{ sock.write(req.repeat(1)); });
    sock.on('close', ()=>{});
    sock.setNoDelay(true);
  });
}
function benchHttp(port, label){
  return new Promise(async (resolve)=>{
    const t0 = performance.now();
    for (let i=0;i<2000;i++){ const r = await fetch(`http://127.0.0.1:${port}/x`, {headers:{authorization:'Bearer t'}}); await r.arrayBuffer(); }
    resolve(performance.now()-t0);
  });
}
const tHttp = await benchHttp(hp, 'http');
const tRawServer = await new Promise(async (resolve)=>{
  const t0 = performance.now();
  // raw client over socket
  const sock = net.connect(rp, '127.0.0.1');
  let buf=''; let n=0;
  sock.setNoDelay(true);
  sock.on('data',(c)=>{ buf+=c.toString(); while(buf.includes('{"ok":true}\n')){ buf=buf.slice(buf.indexOf('{"ok":true}\n')+11); n++; if(n>=2000){ sock.destroy(); resolve(performance.now()-t0); return; } sock.write('GET /x HTTP/1.1\r\nHost: a\r\n\r\n'); } });
  sock.on('connect', ()=>{ sock.write('GET /x HTTP/1.1\r\nHost: a\r\n\r\n'); });
});
console.log(`node:http + fetch 2000 GET: ${tHttp.toFixed(0)}ms (0.35ms/req)`);
console.log(`raw tcp + raw client 2000 GET: ${tRawServer.toFixed(0)}ms (${(tRawServer/2000).toFixed(3)}ms/req)`);
process.exit(0);
