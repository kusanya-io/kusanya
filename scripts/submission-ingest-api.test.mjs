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

test('submission receipt REST boundary is bounded and non-disclosing', () => {
  const resource = read('classes/SubmissionIngestResource.cls');
  assert.match(resource, /Responsibility:/);
  assert.match(
    resource,
    /@RestResource\(urlMapping='\/v1\/submissions\/ingest'\)/,
  );
  assert.match(resource, /global with sharing class SubmissionIngestResource/);
  assert.equal((resource.match(/@HttpPost/g) ?? []).length, 1);
  assert.doesNotMatch(resource, /@HttpGet|@HttpPut|@HttpPatch|@HttpDelete/);
  assert.match(resource, /MAX_REQUEST_BYTES = 1500000/);
  assert.match(
    resource,
    /FeatureManagement\.checkPermission\('Ingest_Kusanya_Submissions'\)/,
  );
  assert.ok(
    resource.indexOf("checkPermission('Ingest_Kusanya_Submissions')") <
      resource.indexOf('request.requestBody'),
  );
  assert.match(resource, /JSON\.deserializeStrict/);
  assert.match(resource, /rejectDuplicateKeys\(body\)/);
  assert.match(resource, /Cache-Control', 'no-store'/);
  assert.doesNotMatch(
    resource,
    /HttpRequest|NamedCredential|OAuth|refreshToken|Exception\.getMessage/,
  );
});

test('submission receipt is one user-mode transaction with no mapping authority', () => {
  const service = read('classes/SubmissionIngestService.cls');
  assert.match(service, /MAX_BATCH_SIZE = 200/);
  assert.match(service, /MAX_XML_BYTES = 750000/);
  assert.equal((service.match(/Database\.setSavepoint\(\)/g) ?? []).length, 1);
  assert.equal(
    (service.match(/Database\.rollback\(receipt\)/g) ?? []).length,
    1,
  );
  assert.equal((service.match(/AccessLevel\.USER_MODE/g) ?? []).length, 3);
  assert.match(service, /FirstPublishLocationId = submissions\[index\]\.Id/);
  assert.match(service, /Crypto\.generateDigest\('SHA-256', xml\)/);
  assert.match(
    service,
    /existing\.Form_Version__c !=\s*formVersionByInstance\.get\(input\.instanceId\)/,
  );
  assert.doesNotMatch(
    service,
    /String\.valueOf\(existing\.Form_Version__c\) !=\s*input\.formVersionId/,
  );
  assert.doesNotMatch(
    service,
    /Answer__c|Task__c|Mapped_Record_Id__c|Database\.upsert|Type\.forName|Schema\.getGlobalDescribe/,
  );
});

test('only the integration permission set can invoke submission receipt', () => {
  const permission = read(
    'customPermissions/Ingest_Kusanya_Submissions.customPermission-meta.xml',
  );
  assert.equal(tag(permission, 'isLicensed'), 'false');
  assert.equal(tag(permission, 'label'), 'Ingest Kusanya Submissions');

  for (const [name, granted] of [
    ['Kusanya_Admin', false],
    ['Kusanya_Integration', true],
    ['Kusanya_Reviewer_Integration', false],
    ['Kusanya_Supervisor', false],
  ]) {
    const xml = read(`permissionsets/${name}.permissionset-meta.xml`);
    assert.equal(
      xml.includes('<apexClass>SubmissionIngestResource</apexClass>'),
      granted,
    );
    assert.equal(
      xml.includes('<name>Ingest_Kusanya_Submissions</name>'),
      granted,
    );
  }
});

test('hosted receipt tests pin bytes replay conflicts and denied principals', () => {
  const source = read('classes/SubmissionIngestResourceTest.cls');
  assert.match(source, /Responsibility:/);
  assert.doesNotMatch(source, /@TestSetup/);
  assert.match(source, /receivesExactBytesAndReplaysWithoutDuplicateRecords/);
  assert.match(source, /refusesConflictsMalformedBodiesAndUngrantedCallers/);
  assert.match(source, /String\.valueOf\(version\.Id\)\.substring\(0, 15\)/);
  assert.match(
    source,
    /EncodingUtil\.base64Encode\(xml\)[\s\S]*EncodingUtil\.base64Encode\(raw\.VersionData\)/,
  );
  assert.match(
    source,
    /Assert\.areEqual\(1, \[SELECT COUNT\(\) FROM Submission__c\]\)/,
  );
  assert.match(source, /"schemaVersion":1,"schemaVersion":1/);
  assert.match(source, /Limits\.getDmlStatements\(\)/);
});
