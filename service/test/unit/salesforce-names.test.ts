import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSalesforceNames,
  SalesforceNameError,
} from '../../src/salesforce-names.js';

void test('synthetic empty and namespaced fixtures qualify only explicitly owned names', () => {
  for (const namespacePrefix of ['', 'ksny__']) {
    const names = createSalesforceNames(namespacePrefix);
    assert.equal(names.namespacePrefix, namespacePrefix);
    assert.equal(names.kusanyaObject('Form__c'), `${namespacePrefix}Form__c`);
    assert.equal(
      names.kusanyaObject('Form_Version__c'),
      `${namespacePrefix}Form_Version__c`,
    );
    assert.equal(names.kusanyaField('Form__c'), `${namespacePrefix}Form__c`);
    assert.equal(
      names.kusanyaField('Version_Number__c'),
      `${namespacePrefix}Version_Number__c`,
    );
    assert.ok(Object.isFrozen(names));
  }
});

void test('target object and field names are unchanged for both configurations', () => {
  for (const namespacePrefix of ['', 'ksny__']) {
    const names = createSalesforceNames(namespacePrefix);
    for (const apiName of [
      'Account',
      'Site_Survey__c',
      'other__Visit__c',
      'ksny__Form__c',
    ])
      assert.equal(names.targetObject(apiName), apiName);
    for (const apiName of [
      'Id',
      'RecordTypeId',
      'Site__c',
      'other__School__c',
      'ksny__Form__c',
    ])
      assert.equal(names.targetField(apiName), apiName);
  }
});

void test('owned parent and child relationship names use the configured prefix', () => {
  for (const namespacePrefix of ['', 'ksny__']) {
    const names = createSalesforceNames(namespacePrefix);
    for (const localName of [
      'Parent__r',
      'Form_Version__r',
      'Questions__r',
      'Choices__r',
    ])
      assert.equal(
        names.kusanyaRelationship(localName),
        `${namespacePrefix}${localName}`,
      );
  }
});

void test('target relationships preserve standard, customer and foreign namespace names', () => {
  for (const namespacePrefix of ['', 'ksny__']) {
    const names = createSalesforceNames(namespacePrefix);
    for (const apiName of [
      'Owner',
      'CreatedBy',
      'Contacts',
      'School__r',
      'Site_Visits__r',
      'other__Parent__r',
      'other__Children__r',
      'ksny__Form_Version__r',
    ])
      assert.equal(names.targetRelationship(apiName), apiName);
  }
});

void test('Apex REST has a namespace path segment without the API-name suffix', () => {
  assert.equal(
    createSalesforceNames('').apexRestPath('v1/forms/publish'),
    '/services/apexrest/v1/forms/publish',
  );
  assert.equal(
    createSalesforceNames('ksny__').apexRestPath('v1/forms/publish'),
    '/services/apexrest/ksny/v1/forms/publish',
  );
  assert.equal(
    createSalesforceNames('other_ns__').apexRestPath('My_Resource/record-1'),
    '/services/apexrest/other_ns/My_Resource/record-1',
  );
});

void test('interleaved resolvers cannot overwrite each other or existing configuration', () => {
  const plain = createSalesforceNames('');
  const prefixed = createSalesforceNames('ksny__');
  for (let index = 0; index < 3; index += 1) {
    assert.equal(prefixed.kusanyaObject('Question__c'), 'ksny__Question__c');
    assert.equal(plain.kusanyaObject('Question__c'), 'Question__c');
    assert.equal(prefixed.kusanyaRelationship('Parent__r'), 'ksny__Parent__r');
    assert.equal(plain.kusanyaRelationship('Parent__r'), 'Parent__r');
    assert.equal(
      prefixed.kusanyaRelationship('Choices__r'),
      'ksny__Choices__r',
    );
    assert.equal(plain.kusanyaRelationship('Choices__r'), 'Choices__r');
    assert.equal(
      prefixed.targetRelationship('other__Parent__r'),
      'other__Parent__r',
    );
    assert.equal(
      plain.targetRelationship('other__Parent__r'),
      'other__Parent__r',
    );
    assert.equal(
      prefixed.apexRestPath('publish'),
      '/services/apexrest/ksny/publish',
    );
    assert.equal(plain.apexRestPath('publish'), '/services/apexrest/publish');
  }
});

void test('namespace prefix accepts supported identifiers and does not normalize case', () => {
  for (const prefix of ['A__', 'A12345678901234__', 'my_ns__', 'MixedCase__'])
    assert.equal(createSalesforceNames(prefix).namespacePrefix, prefix);
});

void test('malformed prefixes fail without echoing input', () => {
  const malformed: unknown[] = [
    undefined,
    null,
    1,
    {},
    [],
    'ksny',
    '__',
    '1bad__',
    '_bad__',
    'bad___',
    'bad__ns__',
    'A1234567890123456__',
    ' ksny__',
    'ksny__ ',
    'bad-secret-value__',
    'ns__/secret-value',
    '../secret-value__',
    'ns%2Fsecret-value__',
    'ns__?secret-value',
    'ns__#secret-value',
    'https://secret-value.example/',
    'ns__\nsecret-value',
    'ns\n__',
    'ns\r__',
    'ns\u2028__',
  ];
  for (const prefix of malformed)
    assert.throws(
      () => createSalesforceNames(prefix as string),
      (error: unknown) => {
        assert.ok(error instanceof SalesforceNameError);
        assert.equal(error.message, 'Invalid Salesforce namespace prefix');
        return true;
      },
    );
});

void test('owned names refuse standard, customer-qualified and already-prefixed identifiers', () => {
  const malformed: unknown[] = [
    undefined,
    null,
    1,
    {},
    [],
    '',
    'Account',
    'Name',
    'Form',
    'Form__r',
    'ksny__Form__c',
    'other__Form__c',
    'ksny__Name__c',
    'Bad___Name__c',
    '1Name__c',
    'Form__c ',
    'Form__c\n',
    'Form__c/secret-value',
    'Form__c?secret-value',
    'Form__c.Field__c',
    "Form__c' OR Name = 'secret-value",
    '/data/site_name',
  ];
  for (const prefix of ['', 'ksny__']) {
    const names = createSalesforceNames(prefix);
    for (const value of malformed) {
      assert.throws(
        () => names.kusanyaObject(value as string),
        SalesforceNameError,
      );
      assert.throws(
        () => names.kusanyaField(value as string),
        SalesforceNameError,
      );
    }
  }
});

void test('owned relationships refuse other suffixes, qualified names and traversal', () => {
  const malformed: unknown[] = [
    undefined,
    null,
    1,
    {},
    [],
    '',
    'Owner',
    'CreatedBy',
    'Parent',
    'Parent__c',
    'Parent__x',
    'Parent__mdt',
    'Parent__e',
    'ksny__Parent__r',
    'other__Parent__r',
    'other__Children__r',
    'Bad___Name__r',
    '1Parent__r',
    'Parent__r ',
    'Parent__r\n',
    'Parent__r.Name',
    'Parent__r.Parent__r',
    'Parent__r/secret-value',
    'Parent__r?secret-value',
    "Parent__r' OR Name = 'secret-value",
    '/data/parent',
  ];
  for (const prefix of ['', 'ksny__']) {
    const names = createSalesforceNames(prefix);
    for (const value of malformed)
      assert.throws(
        () => names.kusanyaRelationship(value as string),
        (error: unknown) => {
          assert.ok(error instanceof SalesforceNameError);
          assert.equal(
            error.message,
            'Invalid Salesforce owned relationship name',
          );
          return true;
        },
      );
  }
});

void test('target identifiers reject expressions, paths and injection instead of rewriting them', () => {
  const malformed: unknown[] = [
    undefined,
    null,
    1,
    {},
    [],
    '',
    '1Name',
    '_Name',
    'Name_',
    'Name___c',
    'Account.Name',
    'Parent__r.Name',
    'other__Parent__r.Owner',
    'Name,Id',
    'Name FROM Account',
    'Name\n',
    "Name' OR Id != null",
    'other__Name__c/secret-value',
    '/data/site_name',
    '../Name',
    'Name%2Fsecret-value',
    'Name?secret-value',
    'Name#secret-value',
    'https://secret-value.example/',
  ];
  for (const prefix of ['', 'ksny__']) {
    const names = createSalesforceNames(prefix);
    for (const value of malformed) {
      assert.throws(
        () => names.targetObject(value as string),
        SalesforceNameError,
      );
      assert.throws(
        () => names.targetField(value as string),
        SalesforceNameError,
      );
      assert.throws(
        () => names.targetRelationship(value as string),
        (error: unknown) => {
          assert.ok(error instanceof SalesforceNameError);
          assert.equal(
            error.message,
            'Invalid Salesforce target relationship name',
          );
          return true;
        },
      );
    }
  }
});

void test('REST resource validation rejects absolute, escaped, query and traversal paths', () => {
  const malformed: unknown[] = [
    undefined,
    null,
    1,
    {},
    [],
    '',
    '/publish',
    'publish/',
    'v1//publish',
    '.',
    '..',
    'v1/../publish',
    'v1/./publish',
    'v1\\publish',
    'v1/%2e%2e/publish',
    'v1/%252e%252e/publish',
    'v1/publish?secret-value',
    'v1/publish#secret-value',
    'v1/publish\n',
    'v1/*',
    'https://secret-value.example/publish',
    '//secret-value.example/publish',
  ];
  for (const prefix of ['', 'ksny__'])
    for (const value of malformed)
      assert.throws(
        () => createSalesforceNames(prefix).apexRestPath(value as string),
        SalesforceNameError,
      );
});
