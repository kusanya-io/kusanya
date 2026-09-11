import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const json = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const project = json('salesforce/sfdx-project.json');
const scratch = json('salesforce/config/project-scratch-def.json');
assert.equal(project.sourceApiVersion, '64.0');
assert.equal(
  project.namespace,
  '',
  'Namespace registration and packaging are deferred.',
);
assert.equal(scratch.edition, 'Developer');
assert.equal(project.packageDirectories[0].path, 'force-app');
for (const name of ['KusanyaRuntime', 'KusanyaRuntimeTest']) {
  const base = `salesforce/force-app/main/default/classes/${name}`;
  const cls = readFileSync(new URL(`${base}.cls`, root), 'utf8');
  const meta = readFileSync(new URL(`${base}.cls-meta.xml`, root), 'utf8');
  assert.match(cls, /Responsibility:/);
  assert.match(meta, /<apiVersion>64\.0<\/apiVersion>/);
}
console.log(
  `Salesforce scaffold metadata checks passed in ${fileURLToPath(root)}. These are not Apex execution or C10 acceptance tests.`,
);
