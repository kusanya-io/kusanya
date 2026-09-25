import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const source = new URL(
  '../salesforce/force-app/main/default/',
  import.meta.url,
);
const read = (path) => readFileSync(new URL(path, source), 'utf8');
const tag = (xml, name) =>
  xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];

test('publication digest is an explicit immutable package identity field', () => {
  const field = read(
    'objects/Form_Version__c/fields/Publication_Digest__c.field-meta.xml',
  );
  assert.equal(tag(field, 'type'), 'Text');
  assert.equal(tag(field, 'length'), '64');
  assert.equal(tag(field, 'caseSensitive'), undefined);
  assert.equal(tag(field, 'unique'), 'false');
  assert.match(tag(field, 'description'), /SHA-256/);
  for (const [name, editable] of [
    ['Kusanya_Admin', 'true'],
    ['Kusanya_Integration', 'true'],
    ['Kusanya_Supervisor', 'false'],
  ]) {
    const permission = read(`permissionsets/${name}.permissionset-meta.xml`);
    const grant = [
      ...permission.matchAll(
        /<fieldPermissions>([\s\S]*?)<\/fieldPermissions>/g,
      ),
    ]
      .map((match) => match[1])
      .find(
        (candidate) =>
          tag(candidate, 'field') === 'Form_Version__c.Publication_Digest__c',
      );
    assert.ok(grant);
    assert.equal(tag(grant, 'editable'), editable);
    assert.equal(tag(grant, 'readable'), 'true');
  }
});

test('publication commit remains internal, user-mode and transaction bounded', () => {
  const lifecycle = read('classes/PublicationLifecycle.cls');
  assert.match(lifecycle, /public with sharing class PublicationLifecycle/);
  assert.doesNotMatch(
    lifecycle,
    /@RestResource|@AuraEnabled|@InvocableMethod|\bwebservice\b/,
  );
  assert.match(lifecycle, /WITH USER_MODE/g);
  assert.match(lifecycle, /AccessLevel\.USER_MODE/g);
  assert.match(lifecycle, /FOR UPDATE/g);
  assert.match(lifecycle, /Database\.setSavepoint\(\)/);
  assert.match(lifecycle, /Database\.rollback\(checkpoint\)/);
  assert.match(lifecycle, /PUBLICATION_COMMIT_REFUSED/);
  assert.match(lifecycle, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(lifecycle, /private static Map<Id, Form_Version__c>/);
  assert.match(lifecycle, /private static Map<Id, Form__c>/);
  assert.doesNotMatch(
    lifecycle,
    /HttpRequest|NamedCredential|OAuth|refreshToken/,
  );
});

test('publication pins exact file versions and protects reachable retention paths', () => {
  const lifecycle = read('classes/PublicationLifecycle.cls');
  assert.match(lifecycle, /FROM ContentVersion/);
  assert.match(
    lifecycle,
    /xformVersionId\.getSObjectType\(\) != ContentVersion\.SObjectType/,
  );
  assert.match(
    lifecycle,
    /XForm_Version__c = String\.valueOf\(xformVersionId\)/,
  );
  assert.match(
    lifecycle,
    /XLSForm_Version__c = String\.valueOf\(xlsformVersionId\)/,
  );
  assert.match(
    lifecycle,
    /requireLatest && \(!xform\.IsLatest \|\| !xlsform\.IsLatest\)/,
  );

  const guard = read('classes/PublicationArtifactGuard.cls');
  assert.match(guard, /public without sharing class PublicationArtifactGuard/);
  assert.doesNotMatch(guard, /\b(?:insert|update|upsert|delete|undelete)\b/i);
  assert.doesNotMatch(guard, /protectVersions/);
  assert.equal(
    existsSync(
      new URL('triggers/PublicationContentVersionRetention.trigger', source),
    ),
    false,
  );
  for (const [trigger, method] of [
    ['PublicationContentDocumentRetention', 'protectDocuments'],
    ['PublicationContentDocumentLinkRetention', 'protectLinks'],
  ]) {
    const body = read(`triggers/${trigger}.trigger`);
    assert.match(body, /before delete/);
    assert.match(body, new RegExp(`PublicationArtifactGuard\\.${method}`));
  }
});

test('every mutable definition trigger invokes the published graph guard', () => {
  for (const trigger of [
    'QuestionIntegrity',
    'MappingDefinition',
    'FieldMappingDefinition',
    'ChoiceListIntegrity',
    'ChoiceIdentity',
    'SkipRuleIntegrity',
  ]) {
    const body = read(`triggers/${trigger}.trigger`);
    assert.match(body, /PublishedDefinitionGuard\./, trigger);
    assert.match(body, /before delete/, trigger);
  }
  const version = read('triggers/FormVersionIdentity.trigger');
  assert.match(version, /PublicationLifecycle\.validateVersions/);
  const form = read('triggers/FormDefinitionDeletion.trigger');
  assert.match(form, /PublicationLifecycle\.validateFormDeletion/);
  assert.match(form, /PublicationLifecycle\.validateForms/);
});
