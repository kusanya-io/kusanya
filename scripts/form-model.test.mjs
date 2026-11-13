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
    'Publisher__c',
  ],
  Form_Version__c: [
    'Form__c',
    'Version_Number__c',
    'Status__c',
    'XForm__c',
    'XLSForm__c',
    'XForm_Version__c',
    'XLSForm_Version__c',
    'Compiled_At__c',
    'Compile_Warnings__c',
    'Published_By__c',
    'Published_At__c',
    'Publication_Digest__c',
    'Change_Log__c',
    'Version_Key__c',
  ],
  Question__c: [
    'Form_Version__c',
    'Parent__c',
    'Order__c',
    'Label__c',
    'Hint__c',
    'Author_Notes__c',
    'Type__c',
    'Required__c',
    'Read_Only__c',
    'Hidden__c',
    'Same_Page__c',
    'Default_Value__c',
    'Calculation__c',
    'Constraint__c',
    'Constraint_Message__c',
    'Regex__c',
    'Regex_Example__c',
    'Minimum__c',
    'Maximum__c',
    'Relevant__c',
    'Appearance__c',
    'Choice_List__c',
    'Repeat_Mode__c',
    'Repeat_Count__c',
    'Repeat_Source_Question__c',
    'Repeat_Max__c',
    'Repeat_As_Table__c',
    'Cascade_Level__c',
    'Require_Live_Photo__c',
    'Media_Max_Seconds__c',
    'Prefill_Source__c',
    'Validation_Script__c',
    'Previous_Version_Question__c',
    'Question_Key__c',
  ],
  Choice_List__c: ['Description__c', 'Owner_Question__c'],
  Choice__c: [
    'Choice_List__c',
    'Value__c',
    'Label__c',
    'Order__c',
    'Filter_Value__c',
    'Score__c',
    'Choice_Key__c',
  ],
  Skip_Rule__c: [
    'Question__c',
    'Source_Question__c',
    'Operator__c',
    'Value__c',
    'Value_To__c',
    'Join__c',
    'Action__c',
  ],
  Mapping__c: [
    'Form_Version__c',
    'Target_Object__c',
    'Record_Type__c',
    'Kind__c',
    'Repeat_Question__c',
    'Parent_Mapping__c',
    'Parent_Lookup_Field__c',
    'Matching_Field__c',
    'Upsert_External_Id_Field__c',
    'Collector_Field__c',
    'Submission_Field__c',
    'Order__c',
  ],
  Field_Mapping__c: [
    'Mapping__c',
    'Question__c',
    'Target_Field__c',
    'Transform__c',
    'Constant_Value__c',
    'Match_Status__c',
    'Match_Detail__c',
    'Source_Kind__c',
    'Target_Key__c',
  ],
};
const submissionObjects = {
  Submission__c: [
    'Form_Version__c',
    'Instance_Id__c',
    'Channel__c',
    'Status__c',
    'Submitted_At__c',
    'Received_At__c',
    'Started_At__c',
    'Ended_At__c',
    'Latitude__c',
    'Longitude__c',
    'Accuracy__c',
    'XML_Hash__c',
    'Raw_XML_Version__c',
    'Mapped_Record_Id__c',
    'Error__c',
    'Failed_Stage__c',
    'Attempts__c',
  ],
  Answer__c: [
    'Submission__c',
    'Question__c',
    'Node_Name__c',
    'Repeat_Path__c',
    'Repeat_Index__c',
    'Parent_Answer__c',
    'Value__c',
    'Numeric_Value__c',
    'Date_Value__c',
    'Datetime_Value__c',
    'Choice__c',
    'File_Content_Document_Id__c',
  ],
  Error_Log__c: [
    'Submission__c',
    'Stage__c',
    'Error_Code__c',
    'Detail__c',
    'Attempt__c',
    'Occurred_At__c',
  ],
  Sync_Log__c: [
    'Started_At__c',
    'Completed_At__c',
    'Status__c',
    'Received_Count__c',
    'Mapped_Count__c',
    'Failed_Count__c',
    'Salesforce_Request_Count__c',
    'Duration_Milliseconds__c',
    'Error_Code__c',
  ],
};
const allObjects = { ...objects, ...submissionObjects };
const derivedKeys = new Set([
  'Form_Version__c.Version_Key__c',
  'Question__c.Question_Key__c',
  'Choice__c.Choice_Key__c',
  'Field_Mapping__c.Target_Key__c',
]);
const fieldXml = (object, field) =>
  read(`objects/${object}/fields/${field}.field-meta.xml`);
const picklistValues = (xml) =>
  [...xml.matchAll(/<value>([\s\S]*?)<\/value>/g)].map((match) =>
    tag(match[1], 'fullName'),
  );

// Source-contract checks only: hosted deployment and Apex establish runtime behavior.
test('model contains the C4 definitions and Phase 2 submission fields with descriptions', () => {
  assert.deepEqual(files('objects/').sort(), Object.keys(allObjects).sort());
  for (const [object, expected] of Object.entries(allObjects)) {
    const base = `objects/${object}/`;
    const objectXml = read(`${base}${object}.object-meta.xml`);
    assert.ok(tag(objectXml, 'description')?.trim(), `${object} description`);
    assert.doesNotMatch(
      objectXml,
      /ksny__|00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?/,
    );
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
  for (const object of Object.keys(allObjects)) {
    const expected = [
      'Folder__c',
      'Form__c',
      'Choice_List__c',
      'Submission__c',
      'Sync_Log__c',
    ].includes(object)
      ? 'Private'
      : 'ControlledByParent';
    const xml = read(`objects/${object}/${object}.object-meta.xml`);
    assert.equal(tag(xml, 'sharingModel'), expected);
    assert.equal(tag(xml, 'externalSharingModel'), expected);
  }
  for (const [object, field, target, writeRequiresMasterRead] of [
    ['Form_Version__c', 'Form__c', 'Form__c', false],
    ['Question__c', 'Form_Version__c', 'Form_Version__c', false],
    ['Choice__c', 'Choice_List__c', 'Choice_List__c', false],
    ['Skip_Rule__c', 'Question__c', 'Question__c', false],
    ['Mapping__c', 'Form_Version__c', 'Form_Version__c', false],
    ['Field_Mapping__c', 'Mapping__c', 'Mapping__c', false],
    ['Answer__c', 'Submission__c', 'Submission__c', true],
    ['Error_Log__c', 'Submission__c', 'Submission__c', true],
  ]) {
    const parent = fieldXml(object, field);
    assert.equal(tag(parent, 'type'), 'MasterDetail');
    assert.equal(tag(parent, 'referenceTo'), target);
    assert.equal(tag(parent, 'reparentableMasterDetail'), 'false');
    assert.equal(
      tag(parent, 'writeRequiresMasterRead'),
      String(writeRequiresMasterRead),
    );
  }
  for (const field of ['XForm__c', 'XLSForm__c']) {
    const xml = read(`objects/Form_Version__c/fields/${field}.field-meta.xml`);
    assert.equal(tag(xml, 'type'), 'Text');
    assert.equal(tag(xml, 'length'), '18');
    assert.match(tag(xml, 'description'), /ContentDocument/);
  }
  for (const field of ['XForm_Version__c', 'XLSForm_Version__c']) {
    const xml = read(`objects/Form_Version__c/fields/${field}.field-meta.xml`);
    assert.equal(tag(xml, 'type'), 'Text');
    assert.equal(tag(xml, 'length'), '18');
    assert.match(tag(xml, 'description'), /ContentVersion/);
  }
  const publisher = fieldXml('Form__c', 'Publisher__c');
  assert.equal(tag(publisher, 'type'), 'Lookup');
  assert.equal(tag(publisher, 'referenceTo'), 'User');
  assert.equal(tag(publisher, 'deleteConstraint'), 'SetNull');
  assert.equal(tag(publisher, 'required'), 'false');
  const reason = read(
    'objects/Form__c/sharingReasons/Publisher_Access__c.sharingReason-meta.xml',
  );
  assert.equal(tag(reason, 'fullName'), 'Publisher_Access__c');
  assert.equal(tag(reason, 'label'), 'Publisher Access');
  for (const [object, field, length] of [
    ['Form_Version__c', 'Version_Key__c', '28'],
    ['Question__c', 'Question_Key__c', '100'],
    ['Choice__c', 'Choice_Key__c', '64'],
  ]) {
    const key = fieldXml(object, field);
    assert.equal(tag(key, 'type'), 'Text');
    assert.equal(tag(key, 'length'), length);
    assert.equal(tag(key, 'unique'), 'true');
    assert.equal(tag(key, 'caseSensitive'), 'true');
    assert.equal(tag(key, 'required'), 'false');
    assert.match(tag(key, 'description'), /derived|generated|computed/i);
  }
});

test('question tree and inline-choice relationships preserve explicit scope and deletion contracts', () => {
  for (const [object, field, target, required] of [
    ['Question__c', 'Parent__c', 'Question__c', false],
    ['Question__c', 'Choice_List__c', 'Choice_List__c', false],
    ['Question__c', 'Repeat_Source_Question__c', 'Question__c', false],
    ['Question__c', 'Previous_Version_Question__c', 'Question__c', false],
    ['Choice_List__c', 'Owner_Question__c', 'Question__c', false],
    ['Skip_Rule__c', 'Source_Question__c', 'Question__c', true],
  ]) {
    const xml = fieldXml(object, field);
    assert.equal(tag(xml, 'type'), 'Lookup');
    assert.equal(tag(xml, 'referenceTo'), target);
    if (object === target) {
      // Salesforce rejects cascade/restrict metadata on a self-lookup.
      assert.equal(tag(xml, 'deleteConstraint'), undefined);
      assert.match(
        tag(xml, 'description'),
        /Apex blocks direct Question deletion/,
      );
      assert.match(tag(xml, 'description'), /outside the delete batch/);
      assert.match(
        tag(xml, 'description'),
        /Parent cascades bypass that guard/,
      );
    } else {
      assert.equal(tag(xml, 'deleteConstraint'), 'Restrict');
    }
    assert.equal(tag(xml, 'required'), String(required));
    assert.ok(tag(xml, 'relationshipName'));
  }
  const question = read('objects/Question__c/Question__c.object-meta.xml');
  assert.equal(tag(tag(question, 'nameField'), 'type'), 'Text');
  assert.match(
    tag(tag(question, 'nameField'), 'description'),
    /XForm node name/,
  );
  assert.match(
    tag(fieldXml('Question__c', 'Parent__c'), 'description'),
    /null parent keeps a once-only question outside every repeat/,
  );
  assert.match(
    tag(fieldXml('Choice_List__c', 'Owner_Question__c'), 'description'),
    /Immutable after creation, including clearing/,
  );
});

test('question types, repeat settings and author notes remain distinct source contracts', () => {
  const type = fieldXml('Question__c', 'Type__c');
  assert.equal(tag(type, 'restricted'), 'true');
  assert.equal(tag(type, 'required'), 'true');
  assert.deepEqual(picklistValues(type), [
    'section',
    'repeat',
    'note',
    'text',
    'text_long',
    'integer',
    'decimal',
    'select_one',
    'select_multiple',
    'date',
    'time',
    'datetime',
    'geopoint',
    'geotrace',
    'geoshape',
    'photo',
    'signature',
    'audio',
    'video',
    'file',
    'barcode',
    'calculate',
    'reference',
    'end',
  ]);
  const repeatMode = fieldXml('Question__c', 'Repeat_Mode__c');
  assert.equal(tag(repeatMode, 'restricted'), 'true');
  assert.deepEqual(picklistValues(repeatMode), [
    'fixed',
    'from_answer',
    'open',
  ]);
  assert.doesNotMatch(repeatMode, /<default>true<\/default>/);
  for (const field of ['Hint__c', 'Author_Notes__c']) {
    const xml = fieldXml('Question__c', field);
    assert.equal(tag(xml, 'type'), 'LongTextArea');
    assert.equal(tag(xml, 'length'), '32768');
  }
  assert.match(
    tag(fieldXml('Question__c', 'Hint__c'), 'description'),
    /Collector-facing help/,
  );
  assert.match(
    tag(fieldXml('Question__c', 'Author_Notes__c'), 'description'),
    /Author and reviewer annotations only/,
  );
  for (const field of [
    'Required__c',
    'Read_Only__c',
    'Hidden__c',
    'Same_Page__c',
    'Repeat_As_Table__c',
    'Require_Live_Photo__c',
  ]) {
    const xml = fieldXml('Question__c', field);
    assert.equal(tag(xml, 'type'), 'Checkbox');
    assert.equal(tag(xml, 'defaultValue'), 'false');
  }
});

test('question and choice numeric constraints and skip-rule enums match C4', () => {
  for (const [object, field, required] of [
    ['Question__c', 'Order', true],
    ['Question__c', 'Repeat_Count', false],
    ['Question__c', 'Repeat_Max', false],
    ['Question__c', 'Cascade_Level', false],
    ['Question__c', 'Media_Max_Seconds', false],
    ['Choice__c', 'Order', true],
    ['Mapping__c', 'Order', true],
  ]) {
    const xml = fieldXml(object, `${field}__c`);
    assert.equal(tag(xml, 'type'), 'Number');
    assert.equal(tag(xml, 'precision'), '9');
    assert.equal(tag(xml, 'scale'), '0');
    assert.equal(tag(xml, 'required'), String(required));
    if (required) assert.equal(tag(xml, 'defaultValue'), '1');
    const rule = read(
      `objects/${object}/validationRules/${field}_Positive_Integer.validationRule-meta.xml`,
    );
    assert.equal(tag(rule, 'active'), 'true');
    assert.ok(tag(rule, 'description')?.trim());
    assert.ok(
      tag(rule, 'errorConditionFormula').includes(
        `MOD(${field}__c, 1) &lt;&gt; 0`,
      ),
    );
    assert.ok(
      tag(rule, 'errorConditionFormula').includes(`${field}__c &lt; 1`),
    );
  }
  const bounds = read(
    'objects/Question__c/validationRules/Minimum_Not_Above_Maximum.validationRule-meta.xml',
  );
  assert.equal(tag(bounds, 'active'), 'true');
  assert.match(
    tag(bounds, 'errorConditionFormula'),
    /Minimum__c &gt; Maximum__c/,
  );
  assert.equal(tag(fieldXml('Choice__c', 'Value__c'), 'required'), 'true');
  assert.equal(tag(fieldXml('Choice__c', 'Value__c'), 'length'), '255');
  assert.equal(tag(fieldXml('Choice__c', 'Label__c'), 'type'), 'LongTextArea');
  for (const [field, expected] of [
    [
      'Operator__c',
      [
        'answered',
        'is',
        'is_not',
        'less_than',
        'greater_than',
        'in_range',
        'contains',
      ],
    ],
    ['Join__c', ['all', 'any']],
    ['Action__c', ['show', 'hide']],
  ]) {
    const xml = fieldXml('Skip_Rule__c', field);
    assert.equal(tag(xml, 'required'), 'true');
    assert.equal(tag(xml, 'restricted'), 'true');
    assert.deepEqual(picklistValues(xml), expected);
  }
});

test('new Apex uses local references, responsibility headers and API 64 without setup DML', () => {
  for (const name of [
    'FormVersionIdentityHandler',
    'FormDefinitionModelTest',
    'QuestionIntegrityHandler',
    'QuestionDefinitionModelTest',
    'QuestionDeletionTest',
    'DefinitionDeletionHandler',
    'DefinitionDeletionTest',
    'ChoiceDefinitionHandler',
    'SkipRuleDefinitionHandler',
    'ChoiceAndSkipRuleModelTest',
    'MappingDefinitionHandler',
    'MappingDefinitionModelTest',
    'MappingDeletionTest',
    'FieldMappingDefinitionHandler',
    'FieldMappingDefinitionModelTest',
    'PublicationLifecycle',
    'PublishedDefinitionGuard',
    'PublisherRecordAccess',
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
  for (const name of [
    'FormVersionIdentity',
    'FormDefinitionDeletion',
    'QuestionIntegrity',
    'ChoiceIdentity',
    'ChoiceListIntegrity',
    'SkipRuleIntegrity',
    'MappingDefinition',
    'FieldMappingDefinition',
    'FormPublisherAccess',
  ]) {
    const trigger = read(`triggers/${name}.trigger`);
    assert.match(trigger, /Responsibility:/);
    assert.doesNotMatch(
      trigger,
      /ksny__|00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?/,
    );
    assert.equal(
      tag(read(`triggers/${name}.trigger-meta.xml`), 'apiVersion'),
      '64.0',
    );
  }
  const questionTrigger = read('triggers/QuestionIntegrity.trigger');
  assert.match(questionTrigger, /before delete/);
  assert.match(questionTrigger, /Trigger\.isDelete/);
  assert.match(questionTrigger, /Trigger\.oldMap/);
  assert.match(
    read('triggers/FormVersionIdentity.trigger'),
    /PublicationLifecycle\.validateVersions/,
  );
  assert.match(
    read('triggers/FormDefinitionDeletion.trigger'),
    /before insert,[\s\S]*before update,[\s\S]*before delete/,
  );
  assert.equal(
    JSON.parse(
      readFileSync(
        new URL('../salesforce/sfdx-project.json', import.meta.url),
        'utf8',
      ),
    ).namespace,
    'ksny',
  );
});

test('permission sets grant scoped definitions and only integration can import or publish', () => {
  const reviewerApi = read(
    'permissionsets/Kusanya_Reviewer_Integration.permissionset-meta.xml',
  );
  assert.ok(tag(reviewerApi, 'description')?.trim());
  const allowedReviewerApiElements = new Set([
    'PermissionSet',
    'description',
    'classAccesses',
    'apexClass',
    'enabled',
    'customPermissions',
    'name',
    'hasActivationRequired',
    'label',
  ]);
  const unexpectedReviewerApiElements = (xml) =>
    [
      ...new Set(
        [...xml.matchAll(/<\/?([A-Za-z_][\w.-]*)/g)].map((match) => match[1]),
      ),
    ].filter((name) => !allowedReviewerApiElements.has(name));
  assert.deepEqual(unexpectedReviewerApiElements(reviewerApi), []);
  for (const forbiddenGrant of [
    '    <userPermissions>\n        <enabled>true</enabled>\n        <name>ModifyAllData</name>\n    </userPermissions>',
    '  <userPermissions><enabled>true</enabled><name>ModifyAllData</name></userPermissions>',
    '  <userPermissions>\n      <enabled>true</enabled>\n      <name>ModifyAllData</name>\n  </userPermissions>',
    '<userPermissions><enabled>true</enabled><name>ModifyAllData</name></userPermissions>',
  ]) {
    assert.deepEqual(
      unexpectedReviewerApiElements(
        reviewerApi.replace(
          '</PermissionSet>',
          `${forbiddenGrant}\n</PermissionSet>`,
        ),
      ),
      ['userPermissions'],
    );
  }
  assert.deepEqual(
    [
      ...reviewerApi.matchAll(/<classAccesses>([\s\S]*?)<\/classAccesses>/g),
    ].map((match) => tag(match[1], 'apexClass')),
    ['DefinitionSnapshotResource'],
  );
  assert.deepEqual(
    [
      ...reviewerApi.matchAll(
        /<customPermissions>([\s\S]*?)<\/customPermissions>/g,
      ),
    ].map((match) => tag(match[1], 'name')),
    ['Review_Kusanya_Definition'],
  );
  assert.doesNotMatch(
    reviewerApi,
    /<objectPermissions>|<fieldPermissions>|Publish_Kusanya|Import_Kusanya_Definition/,
  );
  for (const [name, canWrite, canDelete] of [
    ['Kusanya_Admin', true, true],
    ['Kusanya_Integration', true, false],
    ['Kusanya_Supervisor', false, false],
  ]) {
    const xml = read(`permissionsets/${name}.permissionset-meta.xml`);
    assert.ok(tag(xml, 'description')?.trim());
    const topLevelElements = [
      ...xml.matchAll(/^    <([A-Za-z][A-Za-z0-9]*)>/gm),
    ].map((match) => match[1]);
    const elementRuns = topLevelElements.filter(
      (element, index) =>
        index === 0 || element !== topLevelElements[index - 1],
    );
    assert.equal(
      new Set(elementRuns).size,
      elementRuns.length,
      `${name} repeats a top-level metadata element after another type`,
    );
    assert.doesNotMatch(
      xml,
      /<userPermissions>|<applicationVisibilities>|<externalDataSourceAccesses>|<flowAccesses>|<license>/,
    );
    const classAccesses = [
      ...xml.matchAll(/<classAccesses>([\s\S]*?)<\/classAccesses>/g),
    ].map((match) => match[1]);
    const customPermissions = [
      ...xml.matchAll(/<customPermissions>([\s\S]*?)<\/customPermissions>/g),
    ].map((match) => match[1]);
    if (name === 'Kusanya_Integration') {
      assert.deepEqual(
        classAccesses.map((grant) => tag(grant, 'apexClass')),
        [
          'DefinitionImportResource',
          'DefinitionSnapshotResource',
          'PublicationCommitResource',
          'PublicationArtifactCleanupResource',
        ],
      );
      assert.deepEqual(
        customPermissions.map((grant) => tag(grant, 'name')),
        [
          'Import_Kusanya_Definition',
          'Publish_Kusanya',
          'Review_Kusanya_Definition',
        ],
      );
      for (const grant of [...classAccesses, ...customPermissions]) {
        assert.equal(tag(grant, 'enabled'), 'true');
      }
    } else {
      assert.deepEqual(classAccesses, []);
      assert.deepEqual(customPermissions, []);
    }
    const grants = [
      ...xml.matchAll(/<objectPermissions>([\s\S]*?)<\/objectPermissions>/g),
    ].map((match) => match[1]);
    const definitionGrants = grants.filter((grant) =>
      Object.hasOwn(objects, tag(grant, 'object')),
    );
    assert.deepEqual(
      definitionGrants.map((grant) => tag(grant, 'object')).sort(),
      Object.keys(objects).sort(),
    );
    for (const grant of definitionGrants) {
      assert.equal(tag(grant, 'allowRead'), 'true');
      assert.equal(tag(grant, 'allowCreate'), String(canWrite));
      assert.equal(tag(grant, 'allowEdit'), String(canWrite));
      assert.equal(tag(grant, 'allowDelete'), String(canDelete));
      assert.equal(
        tag(grant, 'viewAllRecords'),
        String(name !== 'Kusanya_Admin'),
      );
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
    const definitionFieldGrants = fieldGrants.filter((grant) =>
      Object.hasOwn(objects, tag(grant, 'field').split('.')[0]),
    );
    assert.deepEqual(
      definitionFieldGrants.map((grant) => tag(grant, 'field')).sort(),
      expected.sort(),
    );
    for (const grant of definitionFieldGrants) {
      assert.equal(tag(grant, 'readable'), 'true');
      assert.equal(
        tag(grant, 'editable'),
        String(
          canWrite &&
            !derivedKeys.has(tag(grant, 'field')) &&
            (tag(grant, 'field') !== 'Form__c.Publisher__c' ||
              name === 'Kusanya_Admin'),
        ),
      );
    }
  }
});

test('submission permissions keep collector data scoped by role', () => {
  const expectedObjects = Object.keys(submissionObjects).sort();
  for (const [name, permissions] of Object.entries({
    Kusanya_Admin: {
      Submission__c: [true, true, false],
      Answer__c: [true, true, true],
      Error_Log__c: [false, false, false],
      Sync_Log__c: [true, true, false],
    },
    Kusanya_Integration: {
      Submission__c: [true, true, false],
      Answer__c: [true, true, true],
      Error_Log__c: [true, false, false],
      Sync_Log__c: [true, true, false],
    },
    Kusanya_Supervisor: {
      Submission__c: [false, false, false],
      Answer__c: [false, false, false],
      Error_Log__c: [false, false, false],
      Sync_Log__c: [false, false, false],
    },
  })) {
    const xml = read(`permissionsets/${name}.permissionset-meta.xml`);
    const grants = [
      ...xml.matchAll(/<objectPermissions>([\s\S]*?)<\/objectPermissions>/g),
    ]
      .map((match) => match[1])
      .filter((grant) =>
        Object.hasOwn(submissionObjects, tag(grant, 'object')),
      );
    assert.deepEqual(
      grants.map((grant) => tag(grant, 'object')).sort(),
      expectedObjects,
    );
    for (const grant of grants) {
      const object = tag(grant, 'object');
      const [create, edit, remove] = permissions[object];
      assert.equal(tag(grant, 'allowRead'), 'true');
      assert.equal(tag(grant, 'allowCreate'), String(create));
      assert.equal(tag(grant, 'allowEdit'), String(edit));
      assert.equal(tag(grant, 'allowDelete'), String(remove));
      assert.equal(tag(grant, 'viewAllRecords'), 'true');
      assert.equal(tag(grant, 'modifyAllRecords'), 'false');
    }
    const fieldGrants = [
      ...xml.matchAll(/<fieldPermissions>([\s\S]*?)<\/fieldPermissions>/g),
    ]
      .map((match) => match[1])
      .filter((grant) =>
        Object.hasOwn(submissionObjects, tag(grant, 'field').split('.')[0]),
      );
    const expectedFields = [];
    for (const [object, fields] of Object.entries(submissionObjects)) {
      for (const field of fields) {
        const metadata = fieldXml(object, field);
        if (
          tag(metadata, 'required') !== 'true' &&
          tag(metadata, 'type') !== 'MasterDetail'
        )
          expectedFields.push(`${object}.${field}`);
      }
    }
    assert.deepEqual(
      fieldGrants.map((grant) => tag(grant, 'field')).sort(),
      expectedFields.sort(),
    );
    for (const grant of fieldGrants) {
      assert.equal(tag(grant, 'readable'), 'true');
      assert.equal(
        tag(grant, 'editable'),
        String(name !== 'Kusanya_Supervisor'),
      );
    }
  }
});
