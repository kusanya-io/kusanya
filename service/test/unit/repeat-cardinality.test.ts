import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FormDefinition } from '../../src/compiler/types.js';
import {
  dynamicRepeatCardinalityPolicy,
  normalizeRepeatCardinality,
  type SubmissionNode,
} from '../../src/submission/repeat-cardinality.js';
import { question, simpleForm } from '../fixtures/compiler.js';
import {
  nestedCountRuntimeForm,
  sectionCountRuntimeForm,
} from '../fixtures/repeat-runtime.js';

const value = (name: string, submitted: string): SubmissionNode => ({
  name,
  value: submitted,
});
const group = (name: string, children: SubmissionNode[]): SubmissionNode => ({
  name,
  children,
});
const names = (node: SubmissionNode, name: string): SubmissionNode[] => {
  const found: SubmissionNode[] = node.name === name ? [node] : [];
  if ('children' in node)
    for (const child of node.children) found.push(...names(child, name));
  return found;
};

function family(count: string, members: string[]): SubmissionNode {
  return group('families', [
    value('member_count', count),
    ...members.map((member) =>
      group('members', [value('member_name', member)]),
    ),
  ]);
}

function rootDynamicForm(): FormDefinition {
  return simpleForm([
    question('row_count', {
      type: 'integer',
      minimum: 0,
      maximum: 2,
      order: 1,
    }),
    question('rows', {
      type: 'repeat',
      repeatMode: 'from_answer',
      repeatSourceQuestion: 'row_count',
      repeatMax: 2,
      order: 2,
    }),
    question('answer', { parent: 'rows' }),
  ]);
}

void test('root dynamic repeats preserve canonical metadata and unknown groups', () => {
  const input = group('data', [
    value('row_count', '1'),
    group('rows', [
      value('answer', 'kept'),
      group('extension', [value('external', 'retained')]),
    ]),
    group('meta', [value('instanceID', 'uuid:synthetic')]),
    group('empty_extension', []),
  ]);
  const result = normalizeRepeatCardinality(rootDynamicForm(), input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.submission, input);
  assert.equal(names(result.submission, 'rows').length, 1);
  assert.deepEqual(names(result.submission, 'instanceID'), [
    value('instanceID', 'uuid:synthetic'),
  ]);
  assert.deepEqual(names(result.submission, 'external'), [
    value('external', 'retained'),
  ]);
  assert.equal(names(result.submission, 'empty_extension').length, 1);
});

void test('submitted counts trim retained Collect rows independently per parent', () => {
  const input = group('data', [
    value('once_note', 'visit'),
    family('1', ['F1-M1', 'F1-M2']),
    family('2', ['F2-M1', 'F2-M2', 'F2-M3']),
    group('meta', [value('instanceID', 'uuid:synthetic')]),
  ]);
  const original = structuredClone(input);
  const result = normalizeRepeatCardinality(nestedCountRuntimeForm(), input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.policy, dynamicRepeatCardinalityPolicy);
  assert.deepEqual(
    names(result.submission, 'member_name').map((node) =>
      'value' in node ? node.value : '',
    ),
    ['F1-M1', 'F2-M1', 'F2-M2'],
  );
  assert.deepEqual(result.excludedInstances, [
    {
      repeatPath: '/data/families/members',
      parentInstances: [1],
      excluded: 1,
    },
    {
      repeatPath: '/data/families/members',
      parentInstances: [2],
      excluded: 1,
    },
  ]);
  assert.deepEqual(input, original);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.submission));
  assert.ok(Object.isFrozen(result.excludedInstances));
  assert.ok(Object.isFrozen(result.excludedInstances[0]!.parentInstances));
});

void test('a root-scoped count is authoritative within every enclosing repeat', () => {
  const household = (limit: string): SubmissionNode =>
    group('households', [
      group('settings', [value('member_limit', limit)]),
      group('survey', [
        group('people', [value('person_note', 'P1')]),
        group('people', [value('person_note', 'P2')]),
        group('people', [value('person_note', 'P3')]),
      ]),
      group('root_counted', [value('root_note', 'R1')]),
      group('root_counted', [value('root_note', 'R2')]),
    ]);
  const result = normalizeRepeatCardinality(
    sectionCountRuntimeForm(),
    group('data', [value('root_count', '1'), household('2'), household('3')]),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(names(result.submission, 'people').length, 5);
  assert.equal(names(result.submission, 'root_counted').length, 2);
  assert.deepEqual(
    result.excludedInstances.map(
      ({ repeatPath, parentInstances, excluded }) => [
        repeatPath,
        parentInstances,
        excluded,
      ],
    ),
    [
      ['/data/households/survey/people', [1], 1],
      ['/data/households/root_counted', [1], 1],
      ['/data/households/root_counted', [2], 1],
    ],
  );
});

void test('zero removes every dynamic instance while fixed repeats remain untouched', () => {
  const result = normalizeRepeatCardinality(
    nestedCountRuntimeForm(),
    group('data', [family('0', ['hidden']), family('1', ['kept'])]),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(names(result.submission, 'families').length, 2);
  assert.deepEqual(
    names(result.submission, 'member_name').map((node) =>
      'value' in node ? node.value : '',
    ),
    ['kept'],
  );
});

void test('missing instances fail closed instead of inventing submitted rows', () => {
  const result = normalizeRepeatCardinality(
    nestedCountRuntimeForm(),
    group('data', [family('2', ['only-one'])]),
  );
  assert.deepEqual(result, {
    ok: false,
    diagnostics: [
      { code: 'SUBMISSION_REPEAT_DEFICIT', location: 'submission.children[0]' },
    ],
  });
});

void test('missing, duplicate and noncanonical dynamic counts fail closed', () => {
  const missing = normalizeRepeatCardinality(
    nestedCountRuntimeForm(),
    group('data', [group('families', [])]),
  );
  assert.deepEqual(missing, {
    ok: false,
    diagnostics: [
      { code: 'SUBMISSION_REPEAT_COUNT', location: 'submission.children[0]' },
    ],
  });

  const duplicate = normalizeRepeatCardinality(
    nestedCountRuntimeForm(),
    group('data', [
      group('families', [
        value('member_count', '1'),
        value('member_count', '1'),
        group('members', [value('member_name', 'kept')]),
      ]),
    ]),
  );
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok)
    assert.equal(duplicate.diagnostics[0]?.code, 'SUBMISSION_DUPLICATE');

  for (const submitted of ['', ' ', '+1', '01', '1.0', '-1', '4']) {
    const result = normalizeRepeatCardinality(
      nestedCountRuntimeForm(),
      group('data', [family(submitted, ['row'])]),
    );
    assert.equal(result.ok, false, JSON.stringify(submitted));
    if (!result.ok)
      assert.equal(
        result.diagnostics[0]?.code,
        'SUBMISSION_REPEAT_COUNT',
        JSON.stringify(submitted),
      );
  }
});

function nestedDynamicForm(): FormDefinition {
  return simpleForm([
    question('outer_count', {
      type: 'integer',
      minimum: 0,
      maximum: 2,
      order: 1,
    }),
    question('outer', {
      type: 'repeat',
      repeatMode: 'from_answer',
      repeatSourceQuestion: 'outer_count',
      repeatMax: 2,
      order: 2,
    }),
    question('inner_count', {
      type: 'integer',
      parent: 'outer',
      minimum: 0,
      maximum: 2,
      order: 1,
    }),
    question('inner', {
      type: 'repeat',
      parent: 'outer',
      repeatMode: 'from_answer',
      repeatSourceQuestion: 'inner_count',
      repeatMax: 2,
      order: 2,
    }),
    question('answer', { parent: 'inner' }),
  ]);
}

void test('nested policies run only inside outer instances retained by the submitted count', () => {
  const result = normalizeRepeatCardinality(
    nestedDynamicForm(),
    group('data', [
      value('outer_count', '1'),
      group('outer', [
        value('inner_count', '1'),
        group('inner', [value('answer', 'kept')]),
        group('inner', [value('answer', 'trimmed')]),
      ]),
      group('outer', [value('inner_count', 'not-a-count')]),
    ]),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(names(result.submission, 'outer').length, 1);
  assert.equal(names(result.submission, 'inner').length, 1);
  assert.deepEqual(result.excludedInstances, [
    { repeatPath: '/data/outer', parentInstances: [], excluded: 1 },
    { repeatPath: '/data/outer/inner', parentInstances: [1], excluded: 1 },
  ]);
});

void test('unknown parsed answers are preserved but known questions cannot move scope', () => {
  const input = group('data', [
    value('unknown_answer', 'preserve me'),
    family('1', ['kept']),
  ]);
  const result = normalizeRepeatCardinality(nestedCountRuntimeForm(), input);
  assert.equal(result.ok, true);
  if (result.ok)
    assert.deepEqual(names(result.submission, 'unknown_answer'), [
      value('unknown_answer', 'preserve me'),
    ]);

  const misplaced = normalizeRepeatCardinality(
    nestedCountRuntimeForm(),
    group('data', [value('member_count', '1')]),
  );
  assert.equal(misplaced.ok, false);
  if (!misplaced.ok)
    assert.equal(
      misplaced.diagnostics[0]?.code,
      'SUBMISSION_QUESTION_PLACEMENT',
    );

  const hiddenUnderUnknown = normalizeRepeatCardinality(
    nestedCountRuntimeForm(),
    group('data', [group('unknown_group', [value('once_note', 'moved')])]),
  );
  assert.equal(hiddenUnderUnknown.ok, false);
  if (!hiddenUnderUnknown.ok)
    assert.equal(
      hiddenUnderUnknown.diagnostics[0]?.code,
      'SUBMISSION_QUESTION_PLACEMENT',
    );
});

void test('hostile node shapes refuse without invoking supplied code', () => {
  let getterCalls = 0;
  let trapCalls = 0;
  const accessor = { name: 'data' };
  Object.defineProperty(accessor, 'children', {
    enumerable: true,
    get() {
      getterCalls++;
      return [];
    },
  });
  const sparse = Array<SubmissionNode>(1);
  const extended = [value('unknown', 'x')];
  Object.defineProperty(extended, 'extra', { value: true, enumerable: true });
  for (const input of [
    accessor,
    new Proxy(
      { name: 'data', children: [] },
      {
        ownKeys() {
          trapCalls++;
          return [];
        },
      },
    ),
    { name: 'data', children: sparse },
    { name: 'data', children: extended },
    { name: 'data', children: [], extra: 'secret' },
  ]) {
    const result = normalizeRepeatCardinality(nestedCountRuntimeForm(), input);
    assert.equal(result.ok, false);
    if (!result.ok)
      assert.equal(result.diagnostics[0]?.code, 'SUBMISSION_SHAPE');
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
  assert.equal(getterCalls, 0);
  assert.equal(trapCalls, 0);
});

void test('submission value and depth budgets refuse before unbounded work', () => {
  const overlong = normalizeRepeatCardinality(
    nestedCountRuntimeForm(),
    group('data', [value('unknown', 'x'.repeat(1_000_001))]),
  );
  assert.equal(overlong.ok, false);
  if (!overlong.ok)
    assert.equal(overlong.diagnostics[0]?.code, 'SUBMISSION_VALUE');

  let deep: SubmissionNode = value('unknown', 'leaf');
  for (let depth = 0; depth < 33; depth++)
    deep = group('unknown_group', [deep]);
  const tooDeep = normalizeRepeatCardinality(
    nestedCountRuntimeForm(),
    group('data', [deep]),
  );
  assert.equal(tooDeep.ok, false);
  if (!tooDeep.ok)
    assert.equal(tooDeep.diagnostics[0]?.code, 'SUBMISSION_LIMIT');
});

void test('equivalent calls are byte-deterministic and never alias caller nodes', () => {
  const input = group('data', [family('1', ['kept', 'trimmed'])]);
  const first = normalizeRepeatCardinality(
    nestedCountRuntimeForm(),
    structuredClone(input),
  );
  const second = normalizeRepeatCardinality(
    nestedCountRuntimeForm(),
    structuredClone(input),
  );
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  if (!first.ok || !('children' in input)) return;
  assert.notEqual(first.submission, input);
  (input.children as SubmissionNode[]).push(
    value('unknown_after_call', 'unchanged result'),
  );
  assert.equal(names(first.submission, 'unknown_after_call').length, 0);
});
