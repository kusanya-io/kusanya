import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = new URL(
  '../salesforce/force-app/main/default/',
  import.meta.url,
);
const read = (path) => readFileSync(new URL(path, source), 'utf8');

test('definition snapshot REST boundary is narrow, bounded and non-disclosing', () => {
  const resource = read('classes/DefinitionSnapshotResource.cls');
  assert.match(resource, /Responsibility:/);
  assert.match(
    resource,
    /@RestResource\(urlMapping='\/v1\/publications\/definition'\)/,
  );
  assert.match(
    resource,
    /global with sharing class DefinitionSnapshotResource/,
  );
  assert.equal((resource.match(/@HttpPost/g) ?? []).length, 1);
  assert.doesNotMatch(resource, /@HttpGet|@HttpPut|@HttpPatch|@HttpDelete/);
  assert.match(resource, /MAX_REQUEST_BYTES = 2048/);
  assert.match(resource, /MAX_RESPONSE_BYTES = 5000000/);
  assert.match(resource, /body\.size\(\) > responseByteLimit/);
  assert.match(
    resource,
    /FeatureManagement\.checkPermission\('Publish_Kusanya'\)/,
  );
  assert.ok(
    resource.indexOf("checkPermission('Publish_Kusanya')") <
      resource.indexOf('request.requestBody'),
  );
  assert.match(resource, /JSON\.createParser\(body\)/);
  assert.doesNotMatch(resource, /JSON\.deserialize/);
  assert.equal(
    (resource.match(/DefinitionSnapshotReader\.readVersion\(/g) ?? []).length,
    1,
  );
  assert.match(resource, /Cache-Control', 'no-store'/);
  assert.doesNotMatch(
    resource,
    /HttpRequest|NamedCredential|OAuth|refreshToken|VersionData/,
  );
});

test('definition snapshot request and refusal contracts are exact', () => {
  const resource = read('classes/DefinitionSnapshotResource.cls');
  for (const field of ['schemaVersion', 'formVersionId']) {
    assert.match(resource, new RegExp(`'${field}'`));
  }
  assert.match(resource, /seen\.contains\(field\)/);
  assert.match(resource, /seen\.size\(\) != REQUEST_FIELDS\.size\(\)/);
  assert.match(resource, /parser\.nextToken\(\) != null/);
  assert.match(resource, /VALUE_NUMBER_INT/);
  for (const code of [
    'DEFINITION_SNAPSHOT_FORBIDDEN',
    'DEFINITION_SNAPSHOT_METHOD',
    'DEFINITION_SNAPSHOT_MEDIA_TYPE',
    'DEFINITION_SNAPSHOT_TOO_LARGE',
    'DEFINITION_SNAPSHOT_REFUSED',
    'DEFINITION_SNAPSHOT_FAILED',
  ]) {
    assert.match(resource, new RegExp(`'${code}'`));
  }
});

test('only integration can invoke the definition snapshot resource', () => {
  for (const [name, granted] of [
    ['Kusanya_Admin', false],
    ['Kusanya_Integration', true],
    ['Kusanya_Supervisor', false],
  ]) {
    const xml = read(`permissionsets/${name}.permissionset-meta.xml`);
    assert.equal(
      xml.includes('<apexClass>DefinitionSnapshotResource</apexClass>'),
      granted,
    );
    assert.equal(xml.includes('<name>Publish_Kusanya</name>'), granted);
  }
});

test('hosted tests cover deterministic success, strict refusal and authorization', () => {
  const source = read('classes/DefinitionSnapshotResourceTest.cls');
  assert.match(source, /Responsibility:/);
  assert.doesNotMatch(source, /@TestSetup/);
  assert.match(source, /returnsDeterministicPortableCrossOwnerSnapshot/);
  assert.match(source, /refusesMalformedOversizedAndWrongIdentityRequests/);
  assert.match(source, /refusesUngrantedPrincipalsBeforeReadingTheBody/);
  assert.match(source, /refusesOversizedResponsesWithoutDisclosure/);
  assert.match(source, /"schemaVersion":1,"schemaVersion":1/);
  assert.match(source, /Limits\.getDmlStatements\(\)/);
  assert.match(source, /Limits\.getQueries\(\)/);
});
