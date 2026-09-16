import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileForm } from '../../src/compiler/compile.js';
import type {
  FormDefinition,
  QuestionDefinition,
  SkipRuleDefinition,
} from '../../src/compiler/types.js';
import {
  mixedRepeatForm,
  nestedRepeatForm,
  question,
  scalarForm,
  simpleForm,
} from '../fixtures/compiler.js';

function xml(input: unknown): string {
  const result = compileForm(input);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('Expected compiled fixture');
  assert.equal(result.validation, 'structural-only');
  return result.xml;
}
function reject(input: unknown, code: string): void {
  const result = compileForm(input);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('Expected rejected fixture');
  assert.equal(result.diagnostics[0]?.code, code);
  assert.equal('xml' in result, false);
}
function rule(extra: Partial<SkipRuleDefinition> = {}): SkipRuleDefinition {
  return {
    question: 'target',
    sourceQuestion: 'source',
    operator: 'is',
    value: 'yes',
    join: 'all',
    action: 'show',
    ...extra,
  };
}

void test('compiles mixed once-only sections and sibling repeats without leaking Author Notes', () => {
  const input = mixedRepeatForm();
  const output = xml(input);
  assert.ok(output.includes('/data/visit/site'));
  assert.ok(!output.includes('/students/site'));
  assert.ok(!output.includes('/samples/site'));
  assert.ok(output.includes('/data/visit/closing'));
  assert.ok(output.includes('Collector help'));
  assert.ok(
    !JSON.stringify(compileForm(input)).includes('AUTHOR_ONLY_SENTINEL_4197'),
  );
  input.questions[0]!.validationScript = 'AUTHOR_ONLY_SENTINEL_4197';
  assert.ok(
    !JSON.stringify(compileForm(input)).includes('AUTHOR_ONLY_SENTINEL_4197'),
  );
  reject(input, 'UNSUPPORTED_QUESTION_OPTION');
});

void test('is deterministic under record reordering and does not mutate source', () => {
  const input = mixedRepeatForm();
  const original = structuredClone(input);
  const result = xml(input);
  assert.deepEqual(input, original);
  input.questions.reverse();
  input.choiceLists.reverse();
  input.choiceLists[0]!.choices.reverse();
  input.skipRules.reverse();
  assert.equal(xml(input), result);
});

void test('compiled scalar, media, regex and calculated fixtures retain collector semantics', () => {
  const output = xml(scalarForm());
  assert.ok(output.includes('regex(.,'));
  assert.ok(output.includes('HH:MM'));
  assert.ok(output.includes('selected(/data/selections'));
  assert.ok(output.includes('type="dateTime"'));
  assert.ok(output.includes('mediatype="image/*"'));
  assert.ok(output.includes('appearance="signature"'));
  assert.ok(output.includes('<internal>literal</internal>'));
  assert.ok(!output.includes('ref="/data/internal"'));
  assert.ok(!output.includes('ref="/data/twice"'));
});

void test('nested repeat references use current-instance-relative paths and scoped fixed helpers', () => {
  const output = xml(nestedRepeatForm());
  assert.ok(output.includes('jr:count="../member_count"'));
  assert.ok(output.includes('jr:count="../_ksny_count_checks"'));
  assert.ok(output.includes('../../member_count'));
  assert.ok(output.includes('/data/families/_ksny_count_checks'));
});

void test('dynamic repeats advertise retained-instance limitation and constrain counts', () => {
  const result = compileForm(mixedRepeatForm());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.warnings[0]?.code, 'DYNAMIC_REPEAT_RETAINS_INSTANCES');
  assert.ok(result.xml.includes('. &gt;= 0'));
  assert.ok(result.xml.includes('. &lt;= 40'));
});

void test('rejects a repeat counted from its own descendant including nested sections (note 28)', () => {
  const form = mixedRepeatForm();
  form.questions.find((q) => q.name === 'student_count')!.parent = 'students';
  reject(form, 'REPEAT_SOURCE_INSIDE');
  form.questions.push(
    question('subsection', { type: 'section', parent: 'students' }),
  );
  form.questions.find((q) => q.name === 'student_count')!.parent = 'subsection';
  reject(form, 'REPEAT_SOURCE_INSIDE');
});

void test('rejects sibling/deeper repeat references for expressions and skip conditions', () => {
  const form = mixedRepeatForm();
  form.questions.find((q) => q.name === 'closing')!.relevant = '${age} > 1';
  reject(form, 'REFERENCE_SCOPE');
  delete form.questions.find((q) => q.name === 'closing')!.relevant;
  form.skipRules = [
    {
      question: 'observation',
      sourceQuestion: 'age',
      operator: 'answered',
      join: 'all',
      action: 'show',
    },
  ];
  reject(form, 'REFERENCE_SCOPE');
});

void test('rejects non-answerable skip sources, including section, repeat and note (note 28)', () => {
  for (const type of ['section', 'repeat', 'note'] as const) {
    const source = question('source', {
      type,
      ...(type === 'repeat' ? { repeatMode: 'open' as const } : {}),
    });
    const form = simpleForm([
      source,
      question('target'),
      ...(type === 'note' ? [] : [question('child', { parent: 'source' })]),
    ]);
    form.skipRules = [rule({ operator: 'answered' })];
    delete form.skipRules[0]!.value;
    reject(form, 'SKIP_SOURCE');
  }
});

void test('skip is_not guards blanks, show/hide uses whole conditions, and raw relevance is combined', () => {
  const form = simpleForm([
    question('source'),
    question('target', { relevant: 'true()' }),
  ]);
  form.skipRules = [rule({ operator: 'is_not', action: 'hide' })];
  const output = xml(form);
  assert.ok(output.includes('string-length(/data/source) &gt; 0'));
  assert.ok(output.includes('/data/source !='));
  assert.ok(output.includes('not('));
  assert.ok(output.includes('true()'));
  form.skipRules.push(rule({ join: 'any' }));
  reject(form, 'SKIP_POLICY_CONFLICT');
});

void test('skip values are escaped as XPath literals and XML, not executable syntax', () => {
  const form = simpleForm([question('source'), question('target')]);
  form.skipRules = [rule({ value: 'a\' or true() or "<&' })];
  const output = xml(form);
  assert.ok(output.includes('concat('));
  assert.ok(output.includes('&lt;&amp;'));
  assert.ok(!output.includes('"<&'));
});

void test('validates skip numeric types, finite operands, ranges and select membership', () => {
  const form = simpleForm([
    question('source', { type: 'integer' }),
    question('target'),
  ]);
  form.skipRules = [rule({ operator: 'in_range', value: '2', valueTo: '8' })];
  xml(form);
  form.skipRules[0]!.valueTo = '1';
  reject(form, 'SKIP_RANGE_ORDER');
  form.skipRules[0]!.valueTo = 'NaN';
  reject(form, 'SKIP_NUMERIC_VALUE');
  const select = scalarForm();
  select.skipRules[0]!.value = 'missing';
  reject(select, 'SKIP_CHOICE_VALUE');
  select.skipRules[0]!.value = 'a';
  select.skipRules[0]!.operator = 'is';
  reject(select, 'SKIP_OPERATOR_TYPE');
});

void test('detects calculation, relevance and inherited-group cycles', () => {
  reject(
    simpleForm([
      question('a', { calculation: '${b}' }),
      question('b', { calculation: '${a}' }),
    ]),
    'DEPENDENCY_CYCLE',
  );
  reject(simpleForm([question('a', { calculation: '.' })]), 'DEPENDENCY_CYCLE');
  reject(
    simpleForm([
      question('g', { type: 'section', relevant: '${a} = 1' }),
      question('a', { parent: 'g' }),
    ]),
    'DEPENDENCY_CYCLE',
  );
  const form = simpleForm([question('source'), question('target')]);
  form.skipRules = [
    rule(),
    rule({ question: 'source', sourceQuestion: 'target' }),
  ];
  reject(form, 'DEPENDENCY_CYCLE');
});

void test('rejects unknown, wrong-type, cyclic, too-deep and reserved definition shapes without partial output', () => {
  reject(null, 'INPUT_SHAPE');
  reject({ ...simpleForm(), secretField: 'do not echo' }, 'INPUT_SHAPE');
  reject({ ...simpleForm(), schemaVersion: 2 }, 'SCHEMA_VERSION');
  reject(simpleForm([question('xmlBad')]), 'QUESTION_NAME');
  reject(simpleForm([question('meta')]), 'QUESTION_NAME');
  reject(simpleForm([question('_ksny_count_repeat')]), 'QUESTION_NAME');
  reject(simpleForm([question('a'), question('a')]), 'DUPLICATE_QUESTION');
  reject(simpleForm([question('a', { parent: 'missing' })]), 'QUESTION_PARENT');
  reject(
    simpleForm([
      question('a', { type: 'section', parent: 'b' }),
      question('b', { type: 'section', parent: 'a' }),
    ]),
    'QUESTION_CYCLE',
  );
  const deep: QuestionDefinition[] = Array.from({ length: 35 }, (_, i) =>
    question(`q${i}`, {
      type: i === 34 ? 'text' : 'section',
      ...(i ? { parent: `q${i - 1}` } : {}),
    }),
  );
  reject(simpleForm(deep), 'TREE_DEPTH');
});

void test('rejects invalid XML controls/lone surrogates but safely preserves Unicode and markup-looking text', () => {
  for (const label of ['bad\u0000', 'bad\u000b', 'bad\ud800', 'bad\uffff'])
    reject(simpleForm([question('a', { label })]), 'INPUT_TEXT');
  const output = xml(
    simpleForm([
      question('a', {
        label: 'Maji 💧 <script> & "text"',
        hint: 'line 1\nline 2',
      }),
    ]),
  );
  assert.ok(output.includes('Maji 💧 &lt;script&gt; &amp;'));
});

void test('fails unsupported configured features explicitly rather than silently dropping semantics', () => {
  for (const extra of [
    { samePage: true },
    { validationScript: 'return true' },
    { prefillSource: 'target.Name' },
    { requireLivePhoto: true },
    { mediaMaxSeconds: 30 },
    { repeatAsTable: true },
    { cascadeLevel: 1 },
  ])
    reject(simpleForm([question('a', extra)]), 'UNSUPPORTED_QUESTION_OPTION');
  reject(
    simpleForm([question('a', { appearance: 'ex:evil' })]),
    'UNSUPPORTED_APPEARANCE',
  );
  reject(simpleForm([question('a', { type: 'end' })]), 'UNSUPPORTED_END');
  reject(
    simpleForm([
      question('a', { type: 'repeat', repeatMode: 'open', repeatMax: 10 }),
      question('b', { parent: 'a' }),
    ]),
    'UNSUPPORTED_OPEN_REPEAT_LIMIT',
  );
  reject(
    simpleForm([question('a', { type: 'note', required: true })]),
    'NOTE_OPTIONS',
  );
});

void test('validates defaults, bounds, choice lists, required hidden nodes and container options', () => {
  reject(
    simpleForm([question('a', { type: 'integer', defaultValue: '1.5' })]),
    'DEFAULT_VALUE',
  );
  reject(simpleForm([question('a', { minimum: 1 })]), 'BOUND_TYPE');
  reject(
    simpleForm([question('a', { type: 'integer', minimum: 2, maximum: 1 })]),
    'BOUND_ORDER',
  );
  reject(
    simpleForm([question('a', { type: 'select_one' })]),
    'QUESTION_CHOICES',
  );
  reject(
    simpleForm([question('a', { required: true, hidden: true })]),
    'HIDDEN_REQUIRED',
  );
  reject(simpleForm([question('a', { type: 'section' })]), 'CONTAINER_OPTIONS');
  reject(
    simpleForm([question('a', { defaultValue: '1', calculation: '1' })]),
    'DEFAULT_CALCULATION_CONFLICT',
  );
  const form = scalarForm();
  form.choiceLists[0]!.choices[0]!.value = 'two words';
  reject(form, 'CHOICE_VALUE');
});

void test('bounds source volume and compiles a synthetic 144-question fixture', () => {
  const form = simpleForm(
    Array.from({ length: 144 }, (_, i) => question(`q_${i}`, { order: i + 1 })),
  );
  xml(form);
  form.questions = Array.from({ length: 501 }, (_, i) => question(`q_${i}`));
  reject(form, 'INPUT_LIMIT');
  reject(
    simpleForm([question('a', { authorNotes: 'x'.repeat(32769) })]),
    'INPUT_TEXT',
  );
});

void test('portable compiler does not depend on Salesforce namespace or record IDs', () => {
  const form: FormDefinition = simpleForm();
  const output = xml(form);
  assert.ok(!output.includes('__c'));
  assert.ok(!output.includes('ksny__'));
  assert.ok(!output.includes('salesforce'));
});

void test('rejects numeric precision loss and exponent bounds instead of emitting invalid XPath or int values', () => {
  reject(
    simpleForm([question('a', { type: 'decimal', minimum: 1e-7 })]),
    'BOUND_PRECISION',
  );
  reject(
    simpleForm([
      question('a', {
        type: 'integer',
        defaultValue: '1.000000000000000000001',
      }),
    ]),
    'SKIP_NUMERIC_VALUE',
  );
  reject(
    simpleForm([
      question('a', { type: 'integer', defaultValue: '2147483648' }),
    ]),
    'DEFAULT_VALUE',
  );
  reject(
    simpleForm([question('a', { type: 'integer', minimum: 0.5 })]),
    'BOUND_PRECISION',
  );
  assert.ok(
    xml(
      simpleForm([question('a', { type: 'decimal', minimum: 0.000001 })]),
    ).includes('. &gt;= 0.000001'),
  );
  const form = simpleForm([
    question('source', { type: 'decimal' }),
    question('target'),
  ]);
  form.skipRules = [
    rule({
      operator: 'in_range',
      value: '999999999999.999999',
      valueTo: '999999999999.999998',
    }),
  ];
  reject(form, 'SKIP_RANGE_ORDER');
});

void test('count-source defaults and bounds cannot contradict generated repeat limits', () => {
  for (const extra of [
    { defaultValue: '-1' },
    { defaultValue: '41' },
    { minimum: 41, defaultValue: '42' },
    { maximum: -1, defaultValue: '-2' },
  ]) {
    const form = mixedRepeatForm();
    Object.assign(
      form.questions.find((q) => q.name === 'student_count')!,
      extra,
    );
    reject(form, 'REPEAT_SOURCE_BOUNDS');
  }
  const form = mixedRepeatForm();
  form.questions.find((q) => q.name === 'student_count')!.defaultValue = '0';
  xml(form);
});

void test('decimal default bounds compare exact supported decimal spellings without double rounding', () => {
  reject(
    simpleForm([
      question('a', {
        type: 'decimal',
        minimum: 999999999999.9999,
        defaultValue: '999999999999.999899',
      }),
    ]),
    'DEFAULT_VALUE',
  );
  reject(
    simpleForm([
      question('a', {
        type: 'decimal',
        maximum: 999999999999.9999,
        defaultValue: '999999999999.999901',
      }),
    ]),
    'DEFAULT_VALUE',
  );
});

void test('required readonly/reference values must be supplied or calculated', () => {
  for (const extra of [{ readOnly: true }, { type: 'reference' as const }]) {
    reject(
      simpleForm([question('a', { ...extra, required: true })]),
      'HIDDEN_REQUIRED',
    );
    xml(
      simpleForm([
        question('a', { ...extra, required: true, defaultValue: '0' }),
      ]),
    );
  }
});

void test('rejects getters, proxies, sparse arrays and custom array methods without executing them', () => {
  let executions = 0;
  const accessor = simpleForm();
  Object.defineProperty(accessor.questions, '0', {
    get() {
      executions++;
      return question('a');
    },
  });
  reject(accessor, 'INPUT_SHAPE');
  assert.equal(executions, 0);
  const proxied = new Proxy(simpleForm(), {
    getPrototypeOf() {
      executions++;
      return Object.prototype;
    },
  });
  reject(proxied, 'INPUT_SHAPE');
  assert.equal(executions, 0);
  const sparse = simpleForm();
  sparse.questions.length = 2;
  reject(sparse, 'INPUT_SHAPE');
  const method = simpleForm();
  Object.defineProperty(method.questions, 'entries', {
    value() {
      executions++;
      return [];
    },
  });
  reject(method, 'INPUT_SHAPE');
  assert.equal(executions, 0);
});

void test('rejects excessive expanded choice output before rendering a shared list repeatedly', () => {
  const form = simpleForm(
    Array.from({ length: 20 }, (_, i) =>
      question(`q${i}`, { type: 'select_one', choiceList: 'shared' }),
    ),
  );
  form.choiceLists = [
    {
      name: 'shared',
      choices: Array.from({ length: 20 }, (_, i) => ({
        value: `c${i}`,
        label: 'x'.repeat(2000),
        order: i + 1,
      })),
    },
  ];
  assert.ok(JSON.stringify(form).length < 50000);
  reject(form, 'OUTPUT_LIMIT');
});
