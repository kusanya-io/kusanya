import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = new URL(
  '../salesforce/force-app/main/default/',
  import.meta.url,
);
const read = (path) => readFileSync(new URL(path, source), 'utf8');
const tag = (xml, name) =>
  xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];

test('publication commit REST boundary is narrow, bounded and non-disclosing', () => {
  const resource = read('classes/PublicationCommitResource.cls');
  assert.match(resource, /Responsibility:/);
  assert.match(
    resource,
    /@RestResource\(urlMapping='\/v1\/publications\/commit'\)/,
  );
  assert.match(resource, /global with sharing class PublicationCommitResource/);
  assert.equal((resource.match(/@HttpPost/g) ?? []).length, 1);
  assert.doesNotMatch(resource, /@HttpGet|@HttpPut|@HttpPatch|@HttpDelete/);
  assert.match(resource, /MAX_REQUEST_BYTES = 200000/);
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
    (resource.match(/PublicationLifecycle\.commitPublication\(/g) ?? []).length,
    1,
  );
  assert.match(resource, /Cache-Control', 'no-store'/);
  assert.doesNotMatch(
    resource,
    /VersionData|HttpRequest|NamedCredential|OAuth|refreshToken/,
  );
});

test('publication request envelope and response contract are exact', () => {
  const resource = read('classes/PublicationCommitResource.cls');
  for (const field of [
    'schemaVersion',
    'formVersionId',
    'publicationDigest',
    'xformVersionId',
    'xlsformVersionId',
    'compileWarnings',
  ]) {
    assert.match(resource, new RegExp(`'${field}'`));
  }
  assert.match(resource, /seen\.contains\(field\)/);
  assert.match(resource, /seen\.size\(\) != REQUEST_FIELDS\.size\(\)/);
  assert.match(resource, /parser\.nextToken\(\) != null/);
  assert.match(resource, /VALUE_NUMBER_INT/);
  assert.match(resource, /VALUE_NULL/);
  for (const code of [
    'PUBLICATION_COMMIT_FORBIDDEN',
    'PUBLICATION_COMMIT_METHOD',
    'PUBLICATION_COMMIT_MEDIA_TYPE',
    'PUBLICATION_COMMIT_TOO_LARGE',
    'PUBLICATION_COMMIT_REFUSED',
    'PUBLICATION_COMMIT_FAILED',
  ]) {
    assert.match(resource, new RegExp(`'${code}'`));
  }
});

test('only the integration permission set can invoke publication', () => {
  const permission = read(
    'customPermissions/Publish_Kusanya.customPermission-meta.xml',
  );
  assert.equal(tag(permission, 'isLicensed'), 'false');
  assert.equal(tag(permission, 'label'), 'Publish Kusanya');

  for (const [name, granted] of [
    ['Kusanya_Admin', false],
    ['Kusanya_Integration', true],
    ['Kusanya_Supervisor', false],
  ]) {
    const xml = read(`permissionsets/${name}.permissionset-meta.xml`);
    assert.equal(
      xml.includes('<apexClass>PublicationCommitResource</apexClass>'),
      granted,
    );
    assert.equal(xml.includes('<name>Publish_Kusanya</name>'), granted);
  }
});

test('hosted tests cover strict decoding, exact retry and denied principals', () => {
  const source = read('classes/PublicationCommitResourceTest.cls');
  assert.match(source, /Responsibility:/);
  assert.doesNotMatch(source, /@TestSetup/);
  assert.match(source, /commitsAndRetriesThroughTheIntegrationBoundary/);
  assert.match(source, /refusesMalformedAndOversizedRequestsWithoutDisclosure/);
  assert.match(source, /refusesAnUngrantedPrincipalBeforeReadingTheBody/);
  assert.match(source, /"schemaVersion":1,"schemaVersion":1/);
  assert.match(source, /Limits\.getDmlStatements\(\)/);
});
