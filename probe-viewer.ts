
import { createApp } from '/workspace/projects/github-core-clone-01-entry/app.ts';
const srv = createApp();
await new Promise((r) => srv.listen(0, r));
const port = (srv.address() as {port:number}).port;
const B = `http://127.0.0.1:${port}`;
const H = {authorization:'Bearer t','content-type':'application/json'};
await fetch(`${B}/api/v3/user/repos`, {method:'POST', headers:H, body: JSON.stringify({name:'vb', private:true})});
await fetch(`${B}/api/v3/repos/adaiversen/vb`, {headers:H});
const gql = async (body: unknown) => {
  const r = await fetch(`${B}/api/graphql`, {method:'POST', headers:{...H}, body: JSON.stringify(body)});
  return [r.status, JSON.stringify(await r.json())];
};
console.log('1', await gql({query:'query V { viewer { login } }'}));
console.log('2', await gql({query:'query R($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId name } }', variables:{owner:'adaiversen', name:'vb'}}));
console.log('3', await gql({query:'query V { viewer { login } }'}));
console.log('4', await gql([{query:'query V { viewer { login } }'},{query:'query T { Issue: __type(name: "Issue") { fields { name } } }'}]));
console.log('5', await gql({query:'query N($id: ID!) { node(id: $id) { id ... on Repository { name nameWithOwner } } }', variables:{id: JSON.parse((await gql({query:'query R2($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }', variables:{owner:'adaiversen', name:'vb'}}))[1].slice(0)).data.repository.id}}));
process.exit(0);
