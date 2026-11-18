
import net from 'node:net';
import http from 'node:http';
const rs = net.createServer((sock)=>{
  sock.on('data', (chunk)=>{
    sock.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\n\r\n{"ok":true}\n');
  });
});
await new Promise(r=>rs.listen(0,r));
const rp = rs.address().port;
const t0 = performance.now();
for (let i=0;i<2000;i++){ const r = await fetch(`http://127.0.0.1:${rp}/x`, {headers:{authorization:'Bearer t'}}); await r.arrayBuffer(); }
console.log(`raw server + fetch client 2000 GET: ${(performance.now()-t0).toFixed(0)}ms (${((performance.now()-t0)/2000).toFixed(3)}ms/req)`);
process.exit(0);
