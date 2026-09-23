import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { compileForm } from '../../src/compiler/compile.js';
import { prepareForm } from '../../src/compiler/prepare.js';
import { renderXForm } from '../../src/compiler/render.js';
import {
  mixedRepeatForm,
  nestedRepeatForm,
  odkFixtures,
  question,
  simpleForm,
} from '../fixtures/compiler.js';

// Updated for finding 60's conventional unprefixed metadata contract.
// These fixed UTF-8 XML hashes protect against both consumers drifting together.
const reviewedXmlHashes = {
  mixed: 'c2e80f3641417435a7d6ffffcfe6bb52ba06acb12c80e7334426a56dcb658b00',
  nested: 'e5a7445aed35b6c09a3cfce374dbe4f24053252c686662c21e9a8261a273c44d',
  scalars: 'f2d7d53e03cc980409b274916ba6ae21ac1f255db90d02fadadef51d3f16ebc5',
  quoted: '0d8520181c046ed70d42c85a9c6dc482cbd5f0c5d9cca567de1962e164419703',
};

void test('shared preparation preserves reviewed fixture XML bytes and public contract', () => {
  for (const name of Object.keys(odkFixtures) as Array<
    keyof typeof odkFixtures
  >) {
    const input = odkFixtures[name]();
    const original = structuredClone(input);
    const prepared = prepareForm(input);
    const compiled = compileForm(input);
    assert.equal(prepared.ok, true);
    assert.equal(compiled.ok, true);
    if (!prepared.ok || !compiled.ok) throw new Error('Fixture must compile');
    const rendered = renderXForm(
      prepared.graph,
      prepared.logic,
      prepared.counts,
    );
    assert.equal(rendered, compiled.xml);
    assert.equal(
      createHash('sha256').update(compiled.xml, 'utf8').digest('hex'),
      reviewedXmlHashes[name],
      name,
    );
    assert.deepEqual(Object.keys(compiled).sort(), [
      'ok',
      'validation',
      'warnings',
      'xml',
    ]);
    assert.equal(compiled.validation, 'structural-only');
    assert.deepEqual(compiled.warnings, prepared.warnings);
    assert.deepEqual(input, original);
    assert.ok(!JSON.stringify(compiled).includes('AUTHOR_ONLY_SENTINEL_4197'));
  }
});

void test('preparation provides generated relevance, constraints and repeat references to renderers', () => {
  const input = mixedRepeatForm();
  input.questions.find((entry) => entry.name === 'reason')!.relevant =
    '${age} > 3';
  const prepared = prepareForm(input);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error('Fixture must prepare');
  assert.equal(
    prepared.logic.get('student_count')?.constraint,
    '(. >= 0) and (. <= 40)',
  );
  assert.equal(
    prepared.logic.get('age')?.constraint,
    '(. >= 0) and (. <= 120)',
  );
  const relevant = prepared.logic.get('reason')?.relevant;
  assert.ok(relevant);
  assert.ok(relevant.includes('../age > 3'));
  assert.ok(relevant.includes("../handwashing = 'no'"));
  assert.ok(relevant.includes('string-length(../handwashing) > 0'));
  assert.ok(!relevant.includes('${'));
  assert.equal(
    prepared.logic.get('students')?.repeatCountPath,
    '/data/visit/student_count',
  );
  assert.deepEqual(prepared.counts, [
    { path: '/data/visit/_ksny_count_samples', value: '5' },
  ]);
  assert.deepEqual(prepared.warnings, [
    {
      code: 'DYNAMIC_REPEAT_CLIENT_SPECIFIC',
      location: 'questions[3]',
    },
  ]);

  const nested = prepareForm(nestedRepeatForm());
  assert.equal(nested.ok, true);
  if (!nested.ok) throw new Error('Nested fixture must prepare');
  assert.equal(nested.logic.get('members')?.repeatCountPath, '../member_count');
  assert.equal(
    nested.logic.get('checks')?.repeatCountPath,
    '../_ksny_count_checks',
  );
});

void test('author annotations remain internal and failures return only structural diagnostics', () => {
  const input = simpleForm([
    question('answer', {
      authorNotes: 'AUTHOR_ONLY_PREPARE_7301',
      regexExample: 'REGEX_EXAMPLE_PREPARE_7301',
    }),
  ]);
  const prepared = prepareForm(input);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error('Fixture must prepare');
  assert.equal(
    prepared.graph.nodes[0]?.definition.authorNotes,
    'AUTHOR_ONLY_PREPARE_7301',
  );
  const compiled = JSON.stringify(compileForm(input));
  assert.ok(!compiled.includes('AUTHOR_ONLY_PREPARE_7301'));
  assert.ok(!compiled.includes('REGEX_EXAMPLE_PREPARE_7301'));

  input.questions[0]!.validationScript = 'AUTHOR_ONLY_PREPARE_7301';
  assert.deepEqual(prepareForm(input), {
    ok: false,
    diagnostics: [
      { code: 'UNSUPPORTED_QUESTION_OPTION', location: 'questions[0]' },
    ],
  });
  assert.deepEqual(compileForm(input), prepareForm(input));
});

void test('preparation retains expanded XML preflight bounds before any renderer runs', () => {
  const input = simpleForm(
    Array.from({ length: 20 }, (_, index) =>
      question(`q${index}`, { type: 'select_one', choiceList: 'shared' }),
    ),
  );
  input.choiceLists = [
    {
      name: 'shared',
      choices: Array.from({ length: 20 }, (_, index) => ({
        value: `c${index}`,
        label: 'x'.repeat(2000),
        order: index + 1,
      })),
    },
  ];
  const prepared = prepareForm(input);
  assert.equal(prepared.ok, false);
  if (prepared.ok) throw new Error('Expanded fixture must exceed budget');
  assert.equal(prepared.diagnostics[0]?.code, 'OUTPUT_LIMIT');
  assert.deepEqual(compileForm(input), prepared);
  assert.deepEqual(Object.keys(prepared).sort(), ['diagnostics', 'ok']);
});
