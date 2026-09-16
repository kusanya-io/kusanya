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

// Captured from the unmodified compiler at bb292e6 before extracting preparation.
// These fixed UTF-8 XML hashes protect against both consumers drifting together.
const originalXmlHashes = {
  mixed: '9bd28e3e4e8ac9016a965dd550176a47fabee6f2ca6e327bc1f75a59209a5d55',
  nested: 'e116c155152d901e027a06d04bb0499c27a4e9fc39278c89752aa0d78d3ad83d',
  scalars: '17d96e2ab852781988877eabb85c9ef2503641ecc2a4bc317b3091603ca2765e',
  quoted: 'c27dafdba7e103118fb754f7b87ce5c814a8bc8c214d384d70ba1a612a09c877',
};

void test('shared preparation preserves pre-refactor fixture XML bytes and public contract', () => {
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
      originalXmlHashes[name],
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
      code: 'DYNAMIC_REPEAT_RETAINS_INSTANCES',
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
