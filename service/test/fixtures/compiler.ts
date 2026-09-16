/** Synthetic definitions only; never import production seed or Salesforce data. */
import type {
  FormDefinition,
  QuestionDefinition,
} from '../../src/compiler/types.js';

export function question(
  name: string,
  extra: Partial<QuestionDefinition> = {},
): QuestionDefinition {
  return { name, type: 'text', order: 1, label: name, ...extra };
}

export function simpleForm(
  questions: QuestionDefinition[] = [question('answer')],
): FormDefinition {
  return {
    schemaVersion: 1,
    form: { key: 'synthetic_form', title: 'Synthetic form', version: 1 },
    questions,
    choiceLists: [],
    skipRules: [],
  };
}

export function mixedRepeatForm(): FormDefinition {
  const form = simpleForm([
    question('visit', { type: 'section', hint: 'Visit guidance', order: 1 }),
    question('site', {
      type: 'reference',
      parent: 'visit',
      order: 1,
      defaultValue: 'Synthetic site',
      authorNotes: 'AUTHOR_ONLY_SENTINEL_4197',
    }),
    question('student_count', {
      type: 'integer',
      parent: 'visit',
      order: 2,
      required: true,
      defaultValue: '2',
    }),
    question('students', {
      type: 'repeat',
      parent: 'visit',
      order: 3,
      repeatMode: 'from_answer',
      repeatSourceQuestion: 'student_count',
      repeatMax: 40,
      hint: 'Student guidance',
    }),
    question('age', {
      type: 'integer',
      parent: 'students',
      minimum: 0,
      maximum: 120,
    }),
    question('handwashing', {
      type: 'select_one',
      parent: 'students',
      choiceList: 'yes_no',
      order: 2,
    }),
    question('reason', {
      parent: 'students',
      order: 3,
      hint: 'Collector help',
    }),
    question('samples', {
      type: 'repeat',
      parent: 'visit',
      order: 4,
      repeatMode: 'fixed',
      repeatCount: 5,
    }),
    question('observation', { parent: 'samples' }),
    question('closing', { parent: 'visit', order: 5 }),
  ]);
  form.choiceLists = [
    {
      name: 'yes_no',
      choices: [
        { value: 'yes', label: 'Yes', order: 1 },
        { value: 'no', label: 'No', order: 2 },
      ],
    },
  ];
  form.skipRules = [
    {
      question: 'reason',
      sourceQuestion: 'handwashing',
      operator: 'is',
      value: 'no',
      join: 'all',
      action: 'show',
    },
  ];
  return form;
}

export function nestedRepeatForm(): FormDefinition {
  return simpleForm([
    question('families', {
      type: 'repeat',
      repeatMode: 'fixed',
      repeatCount: 2,
    }),
    question('member_count', {
      parent: 'families',
      type: 'integer',
      defaultValue: '1',
    }),
    question('members', {
      parent: 'families',
      type: 'repeat',
      repeatMode: 'from_answer',
      repeatSourceQuestion: 'member_count',
      order: 2,
    }),
    question('member_name', {
      parent: 'members',
      relevant: '${member_count} > 0',
    }),
    question('checks', {
      parent: 'families',
      type: 'repeat',
      repeatMode: 'fixed',
      repeatCount: 3,
      order: 3,
    }),
    question('check_note', { parent: 'checks' }),
  ]);
}

export function scalarForm(): FormDefinition {
  const form = simpleForm([
    question('clock', {
      regex: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
      constraintMessage: 'Use HH:MM',
      defaultValue: '09:30',
    }),
    question('long_text', { type: 'text_long', order: 2 }),
    question('amount', {
      type: 'decimal',
      minimum: 0,
      maximum: 1000,
      order: 3,
    }),
    question('twice', {
      type: 'calculate',
      calculation: '${amount} * 2',
      order: 4,
    }),
    ...(
      [
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
      ] as const
    ).map((type, index) => question(`q_${type}`, { type, order: index + 5 })),
    question('intro', { type: 'note', order: 17 }),
    question('internal', { hidden: true, defaultValue: 'literal', order: 18 }),
    question('selections', {
      type: 'select_multiple',
      choiceList: 'letters',
      order: 19,
    }),
    question('conditional', { order: 20 }),
  ]);
  form.choiceLists = [
    {
      name: 'letters',
      choices: [
        { value: 'a', label: 'A', order: 1 },
        { value: 'aa', label: 'AA', order: 2 },
      ],
    },
  ];
  form.skipRules = [
    {
      question: 'conditional',
      sourceQuestion: 'selections',
      operator: 'contains',
      value: 'a',
      join: 'all',
      action: 'show',
    },
  ];
  return form;
}

export function quotedForm(): FormDefinition {
  const literal = `a' or true() or "<&\r\n\t💧`;
  const form = simpleForm([
    question('source', {
      defaultValue: literal,
      label: literal,
      hint: literal,
      authorNotes: 'AUTHOR_ONLY_SENTINEL_4197',
    }),
    question('target', {
      constraint: `string-length(.) >= 0`,
      constraintMessage: literal,
      regex: '^.*$',
    }),
  ]);
  form.skipRules = [
    {
      question: 'target',
      sourceQuestion: 'source',
      operator: 'is',
      value: literal,
      join: 'all',
      action: 'show',
    },
  ];
  return form;
}

export const odkFixtures = {
  mixed: mixedRepeatForm,
  nested: nestedRepeatForm,
  scalars: scalarForm,
  quoted: quotedForm,
};
