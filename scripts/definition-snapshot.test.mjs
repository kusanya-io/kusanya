import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL(
    '../salesforce/force-app/main/default/classes/DefinitionSnapshotReader.cls',
    import.meta.url,
  ),
  'utf8',
);

test('definition snapshot remains an internal user-mode read boundary', () => {
  assert.match(source, /public with sharing class DefinitionSnapshotReader/);
  assert.equal(source.match(/WITH USER_MODE/g)?.length, 7);
  assert.doesNotMatch(source, /@RestResource|@HttpGet|@HttpPost/);
  assert.doesNotMatch(source, /\b(?:insert|update|upsert|delete|undelete)\b/i);
  assert.match(source, /DEFINITION_SNAPSHOT_REFUSED/);
  assert.match(source, /QUESTION_LIMIT = 500/);
  assert.match(source, /CHOICE_LIMIT = 5000/);
  assert.match(source, /SKIP_RULE_LIMIT = 2000/);
  assert.match(source, /MAPPING_LIMIT = 100/);
  assert.match(source, /FIELD_MAPPING_LIMIT = 2000/);
});

test('definition snapshot translates relationships without exporting Salesforce IDs', () => {
  assert.match(source, /'choice_list_' \+ listIndex/);
  assert.match(source, /'mapping_' \+ mappingIndex/);
  assert.match(source, /'form_' \+/);
  assert.doesNotMatch(source, /output\.put\([^\n]*['"]Id['"]/);
  assert.doesNotMatch(
    source,
    /['"](?:recordId|salesforceId|versionId)['"]\s*=>/,
  );
  assert.doesNotMatch(source, /Match_Status__c|Match_Detail__c|Target_Key__c/);
});
