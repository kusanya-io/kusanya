import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const source = new URL(
  '../salesforce/force-app/main/default/',
  import.meta.url,
);
const read = (path) => readFileSync(new URL(path, source), 'utf8');
const files = (path) => readdirSync(new URL(path, source));
const tag = (xml, name) =>
  xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];
const objects = {
  Folder__c: ['Description__c'],
  Form__c: [
    'Status__c',
    'Description__c',
    'Folder__c',
    'Default_Target_Object__c',
    'Current_Version__c',
    'Language__c',
    'Country__c',
    'Allow_Ad_Hoc_Submissions__c',
    'GPS_Capture__c',
    'Close_Message__c',
  ],
  Form_Version__c: [
    'Form__c',
    'Version_Number__c',
    'Status__c',
    'XForm__c',
    'XLSForm__c',
    'Compiled_At__c',
    'Compile_Warnings__c',
    'Published_By__c',
    'Published_At__c',
    'Change_Log__c',
    'Version_Key__c',
  ],
};

// Source-contract checks only: hosted deployment and Apex establish runtime behavior.
test('first model slice contains the C4 Form and Form Version fields with descriptions', () => {
  assert.deepEqual(files('objects/').sort(), Object.keys(objects).sort());
  for (const [object, expected] of Object.entries(objects)) {
    const base = `objects/${object}/`;
    const objectXml = read(`${base}${object}.object-meta.xml`);
    assert.ok(tag(objectXml, 'description')?.trim(), `${object} description`);
    assert.ok(
      tag(tag(objectXml, 'nameField'), 'description')?.trim(),
      `${object}.Name description`,
    );
    assert.deepEqual(
      files(`${base}fields/`)
        .map((file) => file.replace('.field-meta.xml', ''))
        .sort(),
      [...expected].sort(),
    );
    for (const field of expected) {
      const xml = read(`${base}fields/${field}.field-meta.xml`);
      assert.equal(tag(xml, 'fullName'), field);
      assert.ok(
        tag(xml, 'description')?.trim(),
        `${object}.${field} description`,
      );
      assert.doesNotMatch(xml, /ksny__|00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?/);
    }
  }
});

test('model ownership and file pointers use the documented metadata contracts', () => {
  for (const object of ['Folder__c', 'Form__c']) {
    assert.equal(
      tag(read(`objects/${object}/${object}.object-meta.xml`), 'sharingModel'),
      'Private',
    );
  }
  assert.equal(
    tag(
      read('objects/Form_Version__c/Form_Version__c.object-meta.xml'),
      'sharingModel',
    ),
    'ControlledByParent',
  );
  const parent = read('objects/Form_Version__c/fields/Form__c.field-meta.xml');
  assert.equal(tag(parent, 'type'), 'MasterDetail');
  assert.equal(tag(parent, 'referenceTo'), 'Form__c');
  assert.equal(tag(parent, 'reparentableMasterDetail'), 'false');
  for (const field of ['XForm__c', 'XLSForm__c']) {
    const xml = read(`objects/Form_Version__c/fields/${field}.field-meta.xml`);
    assert.equal(tag(xml, 'type'), 'Text');
    assert.equal(tag(xml, 'length'), '18');
    assert.match(tag(xml, 'description'), /ContentDocument/);
  }
  const key = read(
    'objects/Form_Version__c/fields/Version_Key__c.field-meta.xml',
  );
  assert.equal(tag(key, 'unique'), 'true');
  assert.match(tag(key, 'description'), /derived|generated|computed/i);
});

test('new Apex uses local references, responsibility headers and API 64 without setup DML', () => {
  for (const name of [
    'FormVersionIdentityHandler',
    'FormDefinitionModelTest',
  ]) {
    const cls = read(`classes/${name}.cls`);
    assert.match(cls, /Responsibility:/);
    assert.doesNotMatch(cls, /ksny__|00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?/);
    assert.doesNotMatch(
      cls,
      /\bnew\s+(User|Group|GroupMember|QueueSobject|PermissionSetAssignment)\s*\(/,
    );
    assert.equal(
      tag(read(`classes/${name}.cls-meta.xml`), 'apiVersion'),
      '64.0',
    );
  }
  assert.equal(
    tag(read('triggers/FormVersionIdentity.trigger-meta.xml'), 'apiVersion'),
    '64.0',
  );
  assert.equal(
    JSON.parse(
      readFileSync(
        new URL('../salesforce/sfdx-project.json', import.meta.url),
        'utf8',
      ),
    ).namespace,
    '',
  );
});

test('permission sets grant only this model and never grant setup or collector access', () => {
  for (const [name, canWrite, canDelete] of [
    ['Kusanya_Admin', true, true],
    ['Kusanya_Integration', true, false],
    ['Kusanya_Supervisor', false, false],
  ]) {
    const xml = read(`permissionsets/${name}.permissionset-meta.xml`);
    assert.ok(tag(xml, 'description')?.trim());
    assert.doesNotMatch(
      xml,
      /<userPermissions>|<classAccesses>|<applicationVisibilities>/,
    );
    const grants = [
      ...xml.matchAll(/<objectPermissions>([\s\S]*?)<\/objectPermissions>/g),
    ].map((match) => match[1]);
    assert.deepEqual(
      grants.map((grant) => tag(grant, 'object')).sort(),
      Object.keys(objects).sort(),
    );
    for (const grant of grants) {
      assert.equal(tag(grant, 'allowRead'), 'true');
      assert.equal(tag(grant, 'allowCreate'), String(canWrite));
      assert.equal(tag(grant, 'allowEdit'), String(canWrite));
      assert.equal(tag(grant, 'allowDelete'), String(canDelete));
      assert.equal(tag(grant, 'viewAllRecords'), 'false');
      assert.equal(tag(grant, 'modifyAllRecords'), 'false');
    }
    const fieldGrants = [
      ...xml.matchAll(/<fieldPermissions>([\s\S]*?)<\/fieldPermissions>/g),
    ].map((match) => match[1]);
    const expected = [];
    for (const [object, fields] of Object.entries(objects)) {
      for (const field of fields) {
        const fieldXml = read(
          `objects/${object}/fields/${field}.field-meta.xml`,
        );
        if (
          tag(fieldXml, 'required') === 'true' ||
          tag(fieldXml, 'type') === 'MasterDetail'
        )
          continue;
        expected.push(`${object}.${field}`);
      }
    }
    assert.deepEqual(
      fieldGrants.map((grant) => tag(grant, 'field')).sort(),
      expected.sort(),
    );
    for (const grant of fieldGrants) {
      assert.equal(tag(grant, 'readable'), 'true');
      assert.equal(
        tag(grant, 'editable'),
        String(
          canWrite && tag(grant, 'field') !== 'Form_Version__c.Version_Key__c',
        ),
      );
    }
  }
});
