
const doc = `query PullRequestFiles($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      files(first: 10) {
        nodes { path }
      }
    }
  }
}`;
// replicate graphql.ts parser via import
const { __testParse } = await import('/workspace/projects/github-core-clone-01-entry/graphql.ts');
console.log(JSON.stringify(__testParse(doc, { owner: 'a', name: 'b', number: 1 }), null, 1).slice(0, 1200));
process.exit(0);
