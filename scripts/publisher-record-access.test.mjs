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

test('publisher selection is an admin-owned User lookup with a durable sharing reason', () => {
  const field = read('objects/Form__c/fields/Publisher__c.field-meta.xml');
  assert.equal(tag(field, 'type'), 'Lookup');
  assert.equal(tag(field, 'referenceTo'), 'User');
  assert.equal(tag(field, 'deleteConstraint'), 'SetNull');
  assert.equal(tag(field, 'required'), 'false');
  assert.match(tag(field, 'description'), /Kusanya Integration permission set/);

  const reason = read(
    'objects/Form__c/sharingReasons/Publisher_Access.sharingReason-meta.xml',
  );
  assert.equal(tag(reason, 'fullName'), 'Publisher_Access');
  assert.equal(tag(reason, 'label'), 'Publisher Access');

  for (const [name, editable] of [
    ['Kusanya_Admin', 'true'],
    ['Kusanya_Integration', 'false'],
    ['Kusanya_Supervisor', 'false'],
  ]) {
    const permission = read(`permissionsets/${name}.permissionset-meta.xml`);
    const grant = [
      ...permission.matchAll(
        /<fieldPermissions>([\s\S]*?)<\/fieldPermissions>/g,
      ),
    ]
      .map((match) => match[1])
      .find((entry) => tag(entry, 'field') === 'Form__c.Publisher__c');
    assert.ok(grant, `${name} publisher field grant`);
    assert.equal(tag(grant, 'readable'), 'true');
    assert.equal(tag(grant, 'editable'), editable);
    assert.doesNotMatch(
      permission,
      /<modifyAllRecords>true<\/modifyAllRecords>/,
    );
  }
});

test('trigger reconciles only publisher and owner changes through the scoped reason', () => {
  const trigger = read('triggers/FormPublisherAccess.trigger');
  assert.match(
    trigger,
    /after insert,[\s\S]*after update,[\s\S]*after undelete/,
  );
  assert.doesNotMatch(trigger, /before |after delete/);
  assert.match(trigger, /PublisherRecordAccess\.reconcile/);
  assert.equal(
    tag(read('triggers/FormPublisherAccess.trigger-meta.xml'), 'apiVersion'),
    '64.0',
  );

  const handler = read('classes/PublisherRecordAccess.cls');
  assert.match(handler, /public without sharing class PublisherRecordAccess/);
  assert.match(handler, /Publisher__c != before\.Publisher__c/);
  assert.match(handler, /OwnerId != before\.OwnerId/);
  assert.match(handler, /Schema\.Form__Share\.RowCause\.Publisher_Access__c/);
  assert.match(handler, /AccessLevel = 'Edit'/);
  assert.match(handler, /Publisher__c != form\.OwnerId/);
  assert.equal((handler.match(/\bSELECT\b/g) ?? []).length, 1);
  assert.equal((handler.match(/\bdelete\s+existing\b/g) ?? []).length, 1);
  assert.equal((handler.match(/\binsert\s+desired\b/g) ?? []).length, 1);
  assert.doesNotMatch(
    handler,
    /\bnew\s+(User|Group|GroupMember|QueueSobject|PermissionSetAssignment)\s*\(/,
  );
  assert.equal(
    tag(read('classes/PublisherRecordAccess.cls-meta.xml'), 'apiVersion'),
    '64.0',
  );
  assert.match(
    read('classes/PublicationLifecycle.cls'),
    /before\.Publisher__c == after\.Publisher__c/,
  );
});

test('Apex regression covers refusal, shared commit, replacement, revocation and bulk limits', () => {
  const apex = read('classes/PublisherRecordAccessTest.cls');
  assert.match(apex, /assertCommitRefused\(version\.Id, files\)/);
  assert.match(apex, /PublicationLifecycle\.commitPublication/);
  assert.match(apex, /assertShare\(form\.Id, publisher\.Id\)/);
  assert.match(apex, /assertCannotUpdate\(first/);
  assert.match(apex, /assertCannotUpdate\(second/);
  assert.match(apex, /for \(Integer index = 0; index < 200; index\+\+\)/);
  assert.match(apex, /queriesBefore \+ 1/);
  assert.match(apex, /dmlBefore \+ 2/);
  assert.equal(
    tag(read('classes/PublisherRecordAccessTest.cls-meta.xml'), 'apiVersion'),
    '64.0',
  );
});
