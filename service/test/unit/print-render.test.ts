import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { compileForm } from '../../src/compiler/compile.js';
import { renderPrintView } from '../../src/print/render.js';
import { createSalesforceNames } from '../../src/salesforce-names.js';
import { question, simpleForm } from '../fixtures/compiler.js';
import { largeReviewerFixture, reviewerFixture } from '../fixtures/print.js';

function printed() {
  const { form, mappings } = reviewerFixture();
  const result = renderPrintView(form, mappings);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('Synthetic print fixture rejected');
  return { form, mappings, ...result };
}

void test('prints names, labels, types, choices and exact generated logic with a review-only verdict', () => {
  const { html, audience, validation } = printed();
  assert.equal(audience, 'reviewer-only');
  assert.equal(validation, 'structural-only');
  for (const value of [
    'School visit / Ziara ya shule',
    'Was handwashing observed?',
    'select_one',
    'Stored value',
    'yes',
    'no',
    'Collector label',
    'Choices',
    'boolean_yes_no',
    'Observation__c.Age__c',
  ])
    assert.ok(html.includes(value), value);
  assert.ok(
    html.includes(
      '(string-length(../handwashing) &gt; 0) and (../handwashing = &#39;no&#39;)',
    ),
  );
  assert.ok(html.includes('(. &gt;= 0) and (. &lt;= 40)'));
  assert.ok(
    html.includes('(regex(., &#39;^([01][0-9]|2[0-3]):[0-5][0-9]$&#39;))'),
  );
  assert.ok(html.includes('Requested count'));
  assert.ok(html.includes('compiled') || html.includes('Compiled'));
  assert.ok(html.includes('not publication approval'));
  assert.ok(html.includes('not a live Salesforce read'));
  assert.ok(html.includes('No supplied question-to-field assignment.'));
});

void test('author notes and regex examples are reviewer-only, never collector XForm or diagnostics', () => {
  const { form, html } = printed();
  assert.ok(html.includes('Author-only annotations — never collector help'));
  assert.ok(html.includes('REVIEWER_ONLY_7285'));
  assert.ok(html.includes('REGEX_EXAMPLE_7285'));
  assert.ok(html.includes('Collector Hint'));
  const compiled = compileForm(form);
  assert.ok(compiled.ok);
  assert.ok(!JSON.stringify(compiled).includes('REVIEWER_ONLY_7285'));
  assert.ok(!JSON.stringify(compiled).includes('REGEX_EXAMPLE_7285'));
  assert.ok(compiled.xml.includes('Supplied school reference; do not edit.'));
});

void test('print source hash is exactly the ordinary compiler output hash', () => {
  const { form, html } = printed();
  const compiled = compileForm(form);
  assert.ok(compiled.ok);
  const hash = createHash('sha256').update(compiled.xml).digest('hex');
  assert.ok(html.includes(hash));
});

void test('keeps question order, all repeated assignments, constants and mapping settings visible', () => {
  const { html } = printed();
  const names = [
    'visit',
    'site',
    'student_count',
    'students',
    'age',
    'handwashing',
    'reason',
    'samples',
    'observation',
    'closing',
    'visit_time',
  ];
  let prior = -1;
  for (const name of names) {
    const position = html.indexOf(`>${name}</code><span class="type">`);
    assert.ok(position > prior, name);
    prior = position;
  }
  const siteCard = html.slice(
    html.indexOf('<article id="q-2"'),
    html.indexOf('<article id="q-3"'),
  );
  for (const target of [
    'Account.Name',
    'Observation__c.School_Name__c',
    'Sample__c.School_Name__c',
  ])
    assert.ok(siteCard.includes(target), target);
  for (const value of [
    'Literal constant: <span class="literal">0</span>',
    'Literal constant: <span class="literal">false</span>',
    'Blank constant (null in supplied snapshot)',
    'Empty-string constant',
    'Student_Observation',
    'School__c',
    'Collector__c',
    'Submission__c',
    'External_Key__c',
  ])
    assert.ok(html.includes(value), value);
});

void test('shows inherited relevance at its original parent context, not as a child-relative rewrite', () => {
  const form = simpleForm([
    question('enabled', { defaultValue: 'yes' }),
    question('group', {
      type: 'section',
      order: 2,
      relevant: '${enabled} = "yes"',
    }),
    question('child', { parent: 'group', constraint: 'string-length(.) < 20' }),
  ]);
  const result = renderPrintView(form, { schemaVersion: 1, mappings: [] });
  assert.ok(result.ok);
  const child = result.html.slice(result.html.indexOf('<article id="q-3"'));
  assert.ok(
    child.includes('No local condition; parent conditions still apply.'),
  );
  assert.ok(
    child.includes(
      'Parent relevance (evaluated at each parent, not this question)',
    ),
  );
  assert.ok(child.includes('/data/group'));
  assert.ok(child.includes('/data/enabled = &#39;yes&#39;'));
});

void test('shows hidden and calculate questions instead of concealing them from reviewers', () => {
  const form = simpleForm([
    question('input', { type: 'integer', defaultValue: '2' }),
    question('secret', {
      hidden: true,
      defaultValue: 'Synthetic hidden default',
      order: 2,
    }),
    question('computed', {
      type: 'calculate',
      calculation: '${input} * 2',
      order: 3,
    }),
  ]);
  const result = renderPrintView(form, { schemaVersion: 1, mappings: [] });
  assert.ok(result.ok);
  assert.ok(result.html.includes('Synthetic hidden default'));
  assert.ok(result.html.includes('computed'));
  assert.ok(result.html.includes('/data/input * 2'));
  assert.equal(
    (
      result.html.match(
        /<dt>Collector control omitted<\/dt><dd><span class="literal">Yes<\/span>/g,
      ) ?? []
    ).length,
    2,
  );
});

void test('preserves configured customer and foreign namespace spelling without adding an owned prefix', () => {
  for (const prefix of ['', 'ksny__']) {
    const names = createSalesforceNames(prefix);
    const { form, mappings } = reviewerFixture();
    mappings.mappings[1]!.targetObject = names.targetObject(
      'other__Observation__c',
    );
    mappings.mappings[1]!.fields[1]!.targetField =
      names.targetField('other__Age__c');
    const result = renderPrintView(form, mappings);
    assert.ok(result.ok);
    assert.ok(result.html.includes('other__Observation__c.other__Age__c'));
    assert.ok(!result.html.includes('ksny__other__'));
  }
});

void test('escapes every authored HTML surface and emits no executable or fetchable source element', () => {
  const hostile =
    '</title></style><script>globalThis.PRINT_ATTACK=1</script><img src="https://invalid.example/x" onerror="alert(1)"><svg/onload=alert(1)>&\r\n\t"\' 💧';
  const { form, mappings } = reviewerFixture();
  form.form.title = hostile;
  for (const entry of form.questions) {
    entry.label = hostile;
    entry.hint = hostile;
    entry.authorNotes = hostile;
    entry.regexExample = hostile;
    entry.constraintMessage = hostile;
  }
  form.questions.find((entry) => entry.name === 'site')!.defaultValue = hostile;
  form.choiceLists[0]!.choices[0]!.label = hostile;
  mappings.mappings[0]!.label = hostile;
  mappings.mappings[1]!.fields.push({
    sourceKind: 'constant',
    targetField: 'Hostile__c',
    constantValue: hostile,
  });
  const result = renderPrintView(form, mappings);
  assert.ok(result.ok);
  assert.ok(
    !/<(?:script|img|svg|iframe|object|embed|input|form|link|base)\b/i.test(
      result.html,
    ),
  );
  assert.equal((result.html.match(/<style>/g) ?? []).length, 1);
  assert.equal((result.html.match(/<\/style>/g) ?? []).length, 1);
  assert.equal((result.html.match(/<\/title>/g) ?? []).length, 1);
  assert.ok(result.html.includes('&lt;script&gt;'));
  assert.ok(result.html.includes('&#13;'));
  assert.ok(result.html.includes('💧'));
  for (const match of result.html.matchAll(/href="([^"]+)"/g))
    assert.match(match[1]!, /^#[qm]-\d+$/);
});

void test('CSP only permits the exact static style block, with no script/network/base/form allowance', () => {
  const { html } = printed();
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
  const hash = createHash('sha256').update(style).digest('base64');
  assert.ok(html.includes(`style-src &#39;sha256-${hash}&#39;`));
  for (const directive of [
    'default-src',
    'script-src',
    'base-uri',
    'form-action',
    'object-src',
  ])
    assert.ok(html.includes(`${directive} &#39;none&#39;`));
  assert.ok(!html.includes('unsafe-inline'));
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<style>'));
  assert.ok(html.includes('@media print'));
  assert.ok(html.includes('@page'));
});

void test('stable bytes under equivalent record reorderings and no source mutation', () => {
  const { form, mappings } = reviewerFixture();
  const original = structuredClone({ form, mappings });
  const first = renderPrintView(form, mappings);
  assert.ok(first.ok);
  assert.deepEqual({ form, mappings }, original);
  form.questions.reverse();
  form.choiceLists.reverse();
  for (const list of form.choiceLists) list.choices.reverse();
  form.skipRules.reverse();
  mappings.mappings.reverse();
  for (const mapping of mappings.mappings) mapping.fields.reverse();
  const next = renderPrintView(form, mappings);
  assert.ok(next.ok);
  assert.equal(next.html, first.html);
});

void test('renders all 144 synthetic question nodes without claiming the real acceptance fixture', () => {
  const { form, mappings } = largeReviewerFixture();
  assert.equal(form.questions.length, 144);
  const result = renderPrintView(form, mappings);
  assert.ok(result.ok);
  assert.equal((result.html.match(/<article id="q-/g) ?? []).length, 144);
  assert.ok(result.html.includes('answer_13_10'));
});

void test('compiler warnings use canonical paths and explain the client-specific count limitation', () => {
  const { html, warnings } = printed();
  assert.equal(warnings[0]!.code, 'DYNAMIC_REPEAT_RETAINS_INSTANCES');
  assert.ok(html.includes('/data/visit/students'));
  assert.ok(html.includes('Count reduction is client-specific'));
  assert.ok(html.includes('JavaRosa retains existing instances'));
  assert.ok(html.includes('Enketo probe removes trailing answered rows'));
});

void test('invalid/unsupported definitions and malformed mapping summaries return diagnostics with no partial HTML', () => {
  const { form, mappings } = reviewerFixture();
  form.questions[1]!.validationScript = 'AUTHOR_SECRET_THROW';
  const rejected = renderPrintView(form, mappings);
  assert.deepEqual(rejected, compileForm(form));
  assert.ok(!JSON.stringify(rejected).includes('AUTHOR_SECRET_THROW'));
  assert.ok(!Object.hasOwn(rejected, 'html'));
  const invalidMapping = renderPrintView(simpleForm(), {
    schemaVersion: 1,
    mappings: [{ key: 'SECRET_MAPPING' }],
  });
  assert.equal(invalidMapping.ok, false);
  assert.ok(!JSON.stringify(invalidMapping).includes('SECRET_MAPPING'));
  assert.ok(!Object.hasOwn(invalidMapping, 'html'));
  assert.equal(renderPrintView(simpleForm(), undefined).ok, false);
});

void test('hostile form accessors and revoked proxies are rejected without execution', () => {
  let invoked = false;
  const form = simpleForm();
  Object.defineProperty(form.questions[0], 'authorNotes', {
    get() {
      invoked = true;
      throw new Error('Must not execute');
    },
  });
  assert.equal(
    renderPrintView(form, { schemaVersion: 1, mappings: [] }).ok,
    false,
  );
  assert.equal(invoked, false);
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.equal(
    renderPrintView(proxy, { schemaVersion: 1, mappings: [] }).ok,
    false,
  );
});

void test('HTML expansion is bounded before returning an oversized reviewer artifact', () => {
  const form = simpleForm(
    Array.from({ length: 31 }, (_, index) =>
      question(`q${index}`, {
        order: index + 1,
        authorNotes: '&'.repeat(32000),
      }),
    ),
  );
  const compiled = compileForm(form);
  assert.ok(compiled.ok);
  const result = renderPrintView(form, { schemaVersion: 1, mappings: [] });
  assert.deepEqual(result, {
    ok: false,
    diagnostics: [{ code: 'PRINT_OUTPUT_LIMIT', location: 'print' }],
  });
});
