import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileForm } from '../../src/compiler/compile.js';
import type { FormDefinition } from '../../src/compiler/types.js';
import {
  nestedCountRuntimeForm,
  sectionCountRuntimeForm,
} from '../fixtures/repeat-runtime.js';

// Source-level contracts only. Actual engine traversal, editing and saved-record
// reload belong to the optional runtime probes, not these compiler unit tests.
function compileFixture(definition: FormDefinition): string {
  const result = compileForm(definition);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('Synthetic fixture did not compile.');
  assert.equal(result.validation, 'structural-only');
  return result.xml;
}

function assertCountWrappers(
  xml: string,
  expected: ReadonlyArray<readonly [nodeset: string, count: string]>,
): void {
  // JavaRosa anchors a relative jr:count to the enclosing body group, so the
  // wrapper must stay bound to the same node as its repeat. This intentionally
  // checks the compiler's generated control structure rather than XPath alone.
  const wrappers = [
    ...xml.matchAll(
      /<group ref="([^"]+)">\s+<label>[^<]*<\/label>(?:\s+<hint>[^<]*<\/hint>)?\s+<repeat nodeset="([^"]+)" jr:count="([^"]+)" jr:noAddRemove="true\(\)">/g,
    ),
  ];
  assert.equal(wrappers.length, expected.length);
  assert.equal([...xml.matchAll(/<repeat nodeset=/g)].length, expected.length);
  assert.deepEqual(
    wrappers.map((match) => {
      assert.equal(match[1], match[2], 'Repeat wrapper binding must match.');
      return [match[2], match[3]];
    }),
    expected,
  );
}

void test('compiler emits contextualized wrappers for nested dynamic and fixed repeat probes', () => {
  const xml = compileFixture(nestedCountRuntimeForm());
  assertCountWrappers(xml, [
    ['/data/families', '/data/_ksny_count_families'],
    ['/data/families/members', '../member_count'],
    ['/data/families/checks', '../_ksny_count_checks'],
  ]);
  assert.match(xml, /<_ksny_count_families>2<\/_ksny_count_families>/);
  assert.match(
    xml,
    /<families jr:template="">\s+<_ksny_count_checks>3<\/_ksny_count_checks>\s+<member_count>0<\/member_count>/,
  );
  assert.match(xml, /<members jr:template="">\s+<member_name><\/member_name>/);
  assert.match(xml, /<checks jr:template="">\s+<check_note><\/check_note>/);
  assert.match(xml, /<input ref="\/data\/once_note">/);
  assert.doesNotMatch(xml, /\/data\/families\/once_note/);
  assert.match(xml, /<meta>\s+<instanceID\/>\s+<\/meta>/);
  assert.match(
    xml,
    /<bind nodeset="\/data\/meta\/instanceID"[^>]+calculate="once\(concat\(&apos;uuid:&apos;, uuid\(\)\)\)"/,
  );
  assert.doesNotMatch(xml, /orx:(?:meta|instanceID)/);
});

void test('compiler emits multi-level sibling-section and root-scope count references', () => {
  const xml = compileFixture(sectionCountRuntimeForm());
  assertCountWrappers(xml, [
    ['/data/households', '/data/_ksny_count_households'],
    ['/data/households/survey/people', '../../settings/member_limit'],
    ['/data/households/root_counted', '/data/root_count'],
  ]);
  assert.match(
    xml,
    /<settings>\s+<member_limit>0<\/member_limit>\s+<\/settings>/,
  );
  assert.equal([...xml.matchAll(/<root_count>1<\/root_count>/g)].length, 1);
  assert.equal(
    [...xml.matchAll(/<input ref="\/data\/root_count">/g)].length,
    1,
  );
  assert.doesNotMatch(xml, /\/data\/households\/root_count["/<]/);
});

void test('runtime fixture definitions are small, independent and initially have zero per-instance dynamic counts', () => {
  for (const [build, countName, outerName] of [
    [nestedCountRuntimeForm, 'member_count', 'families'],
    [sectionCountRuntimeForm, 'member_limit', 'households'],
  ] as const) {
    const first = build();
    const second = build();
    const count = first.questions.find(
      (question) => question.name === countName,
    );
    const outer = first.questions.find(
      (question) => question.name === outerName,
    );
    assert.equal(count?.defaultValue, '0');
    assert.equal(count?.minimum, 0);
    assert.equal(count?.maximum, 3);
    assert.equal(outer?.repeatCount, 2);
    assert.deepEqual(first, second);
    assert.notEqual(first, second);
    assert.notEqual(first.questions, second.questions);
    for (const question of first.questions) {
      assert.notEqual(
        question,
        second.questions.find((candidate) => candidate.name === question.name),
      );
    }
  }
});

void test('compiler excludes author notes from runtime fixtures while retaining collector guidance', () => {
  for (const build of [nestedCountRuntimeForm, sectionCountRuntimeForm]) {
    const definition = build();
    assert.ok(
      definition.questions.some(
        (question) => question.authorNotes === 'RUNTIME_AUTHOR_ONLY_SENTINEL',
      ),
    );
    const xml = compileFixture(definition);
    assert.doesNotMatch(xml, /RUNTIME_AUTHOR_ONLY_SENTINEL|authorNotes/);
    assert.match(
      xml,
      /<hint>Use 2 for (?:family|household) 1 and 3 for (?:family|household) 2\.<\/hint>/,
    );
  }
});

void test('compiler emits deterministic runtime fixture bytes without mutating their authoring definitions', () => {
  for (const build of [nestedCountRuntimeForm, sectionCountRuntimeForm]) {
    const definition = build();
    const before = structuredClone(definition);
    const first = compileFixture(definition);
    assert.deepEqual(definition, before);
    assert.equal(compileFixture(build()), first);
    const reordered = build();
    reordered.questions.reverse();
    assert.equal(compileFixture(reordered), first);
  }
});
