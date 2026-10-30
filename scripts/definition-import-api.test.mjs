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

test('definition import REST boundary is narrow, bounded and non-disclosing', () => {
  const resource = read('classes/DefinitionImportResource.cls');
  assert.match(resource, /Responsibility:/);
  assert.match(
    resource,
    /@RestResource\(urlMapping='\/v1\/definitions\/import'\)/,
  );
  assert.match(resource, /global with sharing class DefinitionImportResource/);
  assert.equal((resource.match(/@HttpPost/g) ?? []).length, 1);
  assert.doesNotMatch(resource, /@HttpGet|@HttpPut|@HttpPatch|@HttpDelete/);
  assert.match(resource, /MAX_REQUEST_BYTES = 5000000/);
  assert.match(
    resource,
    /FeatureManagement\.checkPermission\('Import_Kusanya_Definition'\)/,
  );
  assert.ok(
    resource.indexOf("checkPermission('Import_Kusanya_Definition')") <
      resource.indexOf('request.requestBody'),
  );
  assert.match(
    resource,
    /rejectDuplicateKeys\(request\.requestBody\.toString\(\)\)/,
  );
  assert.match(resource, /JSON\.deserializeStrict\(/);
  assert.equal(
    (resource.match(/DefinitionImportService\.importDefinition\(/g) ?? [])
      .length,
    1,
  );
  assert.match(resource, /Cache-Control', 'no-store'/);
  assert.doesNotMatch(
    resource,
    /HttpRequest|NamedCredential|OAuth|refreshToken|VersionData/,
  );
});

test('definition persistence is one savepoint with user-mode DML and rollback', () => {
  const service = read('classes/DefinitionImportService.cls');
  assert.match(service, /Responsibility:/);
  assert.match(service, /public with sharing class DefinitionImportService/);
  assert.equal((service.match(/Database\.setSavepoint\(\)/g) ?? []).length, 1);
  assert.equal(
    (service.match(/Database\.rollback\(checkpoint\)/g) ?? []).length,
    1,
  );
  assert.ok((service.match(/AccessLevel\.USER_MODE/g) ?? []).length >= 8);
  assert.doesNotMatch(
    service,
    /HttpRequest|NamedCredential|OAuth|refreshToken|ContentVersion|ContentDocument/,
  );
});

test('only integration can invoke the definition import resource', () => {
  const permission = read(
    'customPermissions/Import_Kusanya_Definition.customPermission-meta.xml',
  );
  assert.equal(tag(permission, 'isLicensed'), 'false');
  assert.equal(tag(permission, 'label'), 'Import Kusanya Definition');

  for (const [name, granted] of [
    ['Kusanya_Admin', false],
    ['Kusanya_Integration', true],
    ['Kusanya_Supervisor', false],
  ]) {
    const xml = read(`permissionsets/${name}.permissionset-meta.xml`);
    assert.equal(
      xml.includes('<apexClass>DefinitionImportResource</apexClass>'),
      granted,
    );
    assert.equal(
      xml.includes('<name>Import_Kusanya_Definition</name>'),
      granted,
    );
  }
});

test('hosted tests cover full graph, late rollback, duplicates and denied users', () => {
  const source = read('classes/DefinitionImportResourceTest.cls');
  assert.match(source, /Responsibility:/);
  assert.doesNotMatch(source, /@TestSetup/);
  assert.match(source, /atomicallyImportsACompletePortableGraph/);
  assert.match(source, /rollsBackEveryRecordWhenALateDefinitionFails/);
  assert.match(
    source,
    /refusesMalformedOversizedAndUngrantedRequestsBeforeDml/,
  );
  assert.match(source, /"schemaVersion":1,"schemaVersion":1/);
  assert.match(source, /AUTHOR_ONLY_IMPORT_SENTINEL/);
  assert.match(source, /Limits\.getDmlStatements\(\)/);
});
