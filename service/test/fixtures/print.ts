/** Synthetic reviewer snapshots. No production seed, record IDs or collector data. */
import { mixedRepeatForm, question } from './compiler.js';
import type { PrintMappingBundle } from '../../src/print/mappings.js';

export function reviewerFixture() {
  const form = mixedRepeatForm();
  form.form = {
    key: 'synthetic_school_review',
    title: 'School visit · definition review',
    version: 3,
  };
  form.questions[0]!.label = 'School visit / Ziara ya shule';
  form.questions[1]!.label = 'School name';
  form.questions[1]!.hint = 'Supplied school reference; do not edit.';
  form.questions[1]!.authorNotes =
    'REVIEWER_ONLY_7285\nCheck the school reference mapping before publication.';
  form.questions[2]!.label = 'How many students will you observe?';
  form.questions[3]!.label = 'Student observations';
  form.questions[4]!.label = 'Age in complete years';
  form.questions[5]!.label = 'Was handwashing observed?';
  form.questions[6]!.label = 'If not, describe why';
  form.questions[7]!.label = 'Five fixed samples';
  form.questions[8]!.label = 'Sample observation';
  form.questions[9]!.label = 'Closing comments (once per visit)';
  form.questions.push(
    question('visit_time', {
      parent: 'visit',
      order: 6,
      label: 'Visit time',
      hint: 'Enter a 24-hour time.',
      regex: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
      regexExample: 'REGEX_EXAMPLE_7285: 09:30',
      constraintMessage: 'Use HH:MM',
      required: true,
    }),
  );
  const mappings: PrintMappingBundle = {
    schemaVersion: 1,
    mappings: [
      {
        key: 'school',
        label: 'Resolve the supplied school',
        order: 1,
        kind: 'reference',
        targetObject: 'Account',
        matchingField: 'Name',
        fields: [
          { sourceKind: 'question', question: 'site', targetField: 'Name' },
        ],
      },
      {
        key: 'student_observation',
        order: 2,
        kind: 'repeat',
        targetObject: 'Observation__c',
        repeatQuestion: 'students',
        recordType: 'Student_Observation',
        parentMapping: 'school',
        parentLookupField: 'School__c',
        collectorField: 'Collector__c',
        submissionField: 'Submission__c',
        fields: [
          {
            sourceKind: 'question',
            question: 'site',
            targetField: 'School_Name__c',
          },
          {
            sourceKind: 'question',
            question: 'age',
            targetField: 'Age__c',
            transform: 'number',
          },
          {
            sourceKind: 'question',
            question: 'handwashing',
            targetField: 'Observed__c',
            transform: 'boolean_yes_no',
          },
          {
            sourceKind: 'question',
            question: 'reason',
            targetField: 'Reason__c',
          },
          {
            sourceKind: 'constant',
            constantValue: '0',
            targetField: 'Initial_Count__c',
          },
          {
            sourceKind: 'constant',
            constantValue: 'false',
            targetField: 'Archived__c',
          },
        ],
      },
      {
        key: 'sample',
        order: 3,
        kind: 'repeat',
        targetObject: 'Sample__c',
        repeatQuestion: 'samples',
        parentMapping: 'school',
        parentLookupField: 'School__c',
        upsertExternalIdField: 'External_Key__c',
        fields: [
          {
            sourceKind: 'question',
            question: 'site',
            targetField: 'School_Name__c',
          },
          {
            sourceKind: 'question',
            question: 'observation',
            targetField: 'Description__c',
          },
          {
            sourceKind: 'constant',
            constantValue: null,
            targetField: 'Blank_Value__c',
          },
          {
            sourceKind: 'constant',
            constantValue: '',
            targetField: 'Empty_String__c',
          },
        ],
      },
    ],
  };
  return { form, mappings };
}

export function largeReviewerFixture() {
  const form = mixedRepeatForm();
  form.form = {
    key: 'synthetic_large_review',
    title: 'Synthetic 144-question review',
    version: 1,
  };
  form.questions = [];
  form.choiceLists = [];
  form.skipRules = [];
  for (let section = 1; section <= 13; section++) {
    form.questions.push(
      question(`section_${section}`, {
        type: 'section',
        order: section,
        label: `Section ${section}`,
      }),
    );
    for (let item = 1; item <= (section <= 1 ? 11 : 10); item++) {
      form.questions.push(
        question(`answer_${section}_${item}`, {
          parent: `section_${section}`,
          order: item,
          label: `Synthetic question ${section}.${item}`,
        }),
      );
    }
  }
  return { form, mappings: { schemaVersion: 1 as const, mappings: [] } };
}
