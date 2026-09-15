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
const field = (object, name) =>
  read(`objects/${object}/fields/${name}.field-meta.xml`);
const values = (xml) =>
  [...xml.matchAll(/<value>([\s\S]*?)<\/value>/g)].map((match) => ({
    name: tag(match[1], 'fullName'),
    isDefault: tag(match[1], 'default') === 'true',
  }));

// Offline source contracts only; deployability and behavior require real Apex runs.
test('mapping target identifiers are portable text, not destination-org lookup IDs', () => {
  for (const [object, name, required] of [
    ['Mapping__c', 'Target_Object__c', true],
    ['Mapping__c', 'Record_Type__c', false],
    ['Mapping__c', 'Parent_Lookup_Field__c', false],
    ['Mapping__c', 'Matching_Field__c', false],
    ['Mapping__c', 'Upsert_External_Id_Field__c', false],
    ['Mapping__c', 'Collector_Field__c', false],
    ['Mapping__c', 'Submission_Field__c', false],
    ['Field_Mapping__c', 'Target_Field__c', true],
  ]) {
    const xml = field(object, name);
    assert.equal(tag(xml, 'type'), 'Text');
    assert.equal(tag(xml, 'length'), '255');
    assert.equal(tag(xml, 'required'), String(required));
    assert.equal(tag(xml, 'referenceTo'), undefined);
    assert.match(tag(xml, 'description'), /verbatim/i);
  }
  assert.match(
    tag(field('Mapping__c', 'Record_Type__c'), 'description'),
    /DeveloperName, not an org-specific record ID/,
  );
  assert.match(
    tag(field('Mapping__c', 'Collector_Field__c'), 'description'),
    /authenticated collector stamp/,
  );
  assert.match(
    tag(field('Mapping__c', 'Submission_Field__c'), 'description'),
    /trusted submission stamp/,
  );
});

test('mapping kinds and field transforms retain every C4 enum', () => {
  for (const [object, name, expected, defaultValue] of [
    ['Mapping__c', 'Kind__c', ['main', 'repeat', 'reference'], 'main'],
    [
      'Field_Mapping__c',
      'Transform__c',
      [
        'none',
        'picklist_match',
        'multi_select_join',
        'lookup_by_external_id',
        'date_only',
        'boolean_yes_no',
        'number',
        'text_truncate',
        'geopoint_lat',
        'geopoint_lng',
        'geopoint_accuracy',
        'file_url',
      ],
      'none',
    ],
  ]) {
    const xml = field(object, name);
    assert.equal(tag(xml, 'type'), 'Picklist');
    assert.equal(tag(xml, 'required'), 'true');
    assert.equal(tag(xml, 'restricted'), 'true');
    assert.deepEqual(
      values(xml).map((value) => value.name),
      expected,
    );
    assert.deepEqual(
      values(xml)
        .filter((value) => value.isDefault)
        .map((value) => value.name),
      [defaultValue],
    );
  }
});

test('explicit source kind preserves empty constants independently of a question lookup', () => {
  const kind = field('Field_Mapping__c', 'Source_Kind__c');
  assert.equal(tag(kind, 'required'), 'true');
  assert.equal(tag(kind, 'restricted'), 'true');
  assert.deepEqual(values(kind), [
    { name: 'question', isDefault: true },
    { name: 'constant', isDefault: false },
  ]);
  const constant = field('Field_Mapping__c', 'Constant_Value__c');
  assert.equal(tag(constant, 'type'), 'LongTextArea');
  assert.equal(tag(constant, 'length'), '32768');
  assert.match(tag(constant, 'description'), /explicit blank constant/);
  assert.equal(
    tag(field('Field_Mapping__c', 'Question__c'), 'required'),
    'false',
  );
});

test('mapping lookups allow owner cascades without unsupported self-lookup restrict metadata', () => {
  const parent = field('Mapping__c', 'Parent_Mapping__c');
  assert.equal(tag(parent, 'type'), 'Lookup');
  assert.equal(tag(parent, 'referenceTo'), 'Mapping__c');
  assert.equal(tag(parent, 'required'), 'false');
  assert.equal(tag(parent, 'deleteConstraint'), undefined);
  assert.match(tag(parent, 'description'), /outside the delete batch/);
  for (const [object, name] of [
    ['Mapping__c', 'Repeat_Question__c'],
    ['Field_Mapping__c', 'Question__c'],
  ]) {
    const xml = field(object, name);
    assert.equal(tag(xml, 'type'), 'Lookup');
    assert.equal(tag(xml, 'referenceTo'), 'Question__c');
    assert.equal(tag(xml, 'required'), 'false');
    assert.equal(tag(xml, 'deleteConstraint'), 'SetNull');
    assert.match(
      tag(xml, 'description'),
      /Apex guards direct referenced Question deletion/,
    );
  }
});

test('mapping diagnostics start unchecked and never establish authorization', () => {
  const status = field('Field_Mapping__c', 'Match_Status__c');
  assert.equal(tag(status, 'required'), 'false');
  assert.equal(tag(status, 'restricted'), 'true');
  assert.deepEqual(values(status), [
    { name: 'ok', isDefault: false },
    { name: 'warning', isDefault: false },
    { name: 'error', isDefault: false },
  ]);
  assert.match(tag(status, 'description'), /absent means not checked/);
  assert.match(tag(status, 'description'), /never authorization/);
  const detail = field('Field_Mapping__c', 'Match_Detail__c');
  assert.equal(tag(detail, 'type'), 'LongTextArea');
  assert.equal(tag(detail, 'length'), '32768');
  assert.match(tag(detail, 'description'), /advisory only/);
});

test('field target identity is a derived case-insensitive unique digest, not a portable external ID', () => {
  const key = field('Field_Mapping__c', 'Target_Key__c');
  assert.equal(tag(key, 'type'), 'Text');
  assert.equal(tag(key, 'length'), '64');
  assert.equal(tag(key, 'required'), 'false');
  assert.equal(tag(key, 'unique'), 'true');
  assert.equal(tag(key, 'caseSensitive'), 'false');
  assert.notEqual(tag(key, 'externalId'), 'true');
  assert.match(tag(key, 'description'), /SHA-256 identity derived/);
  assert.match(tag(key, 'description'), /caller values are overwritten/);
});
