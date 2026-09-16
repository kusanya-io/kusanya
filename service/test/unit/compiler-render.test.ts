import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderXForm } from '../../src/compiler/render.js';
import type { RenderLogic } from '../../src/compiler/render.js';
import type {
  ChoiceListDefinition,
  DefinitionGraph,
  FormDefinition,
  QuestionDefinition,
  QuestionNode,
} from '../../src/compiler/types.js';

// This helper makes validated renderer graphs, not an alternative compiler.
function graph(
  questions: QuestionDefinition[],
  choiceLists: ChoiceListDefinition[] = [],
): DefinitionGraph {
  const definition: FormDefinition = {
    schemaVersion: 1,
    form: { key: 'synthetic_form', title: 'Synthetic form', version: 1 },
    questions,
    choiceLists,
    skipRules: [],
  };
  const byName = new Map<string, QuestionNode>();
  const roots: QuestionNode[] = [];
  const nodes = questions.map((question, index): QuestionNode => {
    const parent =
      question.parent === undefined ? undefined : byName.get(question.parent);
    const node: QuestionNode = {
      definition: question,
      index,
      path: `${parent?.path ?? '/data'}/${question.name}`,
      parent,
      children: [],
      repeats:
        parent === undefined
          ? []
          : [
              ...parent.repeats,
              ...(parent.definition.type === 'repeat'
                ? [parent.definition.name]
                : []),
            ],
    };
    byName.set(question.name, node);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
    return node;
  });
  return {
    definition,
    nodes,
    roots,
    byName,
    lists: new Map(choiceLists.map((list) => [list.name, list])),
  };
}

void test('renderer retains once-only siblings and nests repeat controls with a labelled wrapper', () => {
  const input = graph([
    { name: 'visit', type: 'section', order: 1, label: 'Visit' },
    {
      name: 'site',
      parent: 'visit',
      type: 'text',
      order: 1,
      label: 'Site',
      defaultValue: 'One',
    },
    {
      name: 'observation',
      parent: 'visit',
      type: 'repeat',
      order: 2,
      label: 'Observation',
      repeatMode: 'fixed',
      repeatCount: 2,
    },
    {
      name: 'value',
      parent: 'observation',
      type: 'integer',
      order: 1,
      label: 'Value',
    },
  ]);
  const xml = renderXForm(
    input,
    new Map([['observation', { repeatCountPath: '/data/visit/_count' }]]),
    [{ path: '/data/visit/_count', value: '2' }],
  );
  assert.match(
    xml,
    /<visit>\s+<_count>2<\/_count>\s+<site>One<\/site>\s+<observation jr:template="">\s+<value><\/value>\s+<\/observation>\s+<\/visit>/,
  );
  assert.match(xml, /<input ref="\/data\/visit\/site">/);
  assert.match(
    xml,
    /<group ref="\/data\/visit\/observation">\s+<label>Observation<\/label>\s+<repeat nodeset="\/data\/visit\/observation" jr:count="\/data\/visit\/_count" jr:noAddRemove="true\(\)">\s+<input ref="\/data\/visit\/observation\/value">/,
  );
  assert.doesNotMatch(xml, /<repeat[^>]*>\s+<label>/);
  assert.doesNotMatch(xml, /\/data\/visit\/observation\/site/);
});

void test('renderer injects fixed-count helpers inside the enclosing repeat, not inside the counted repeat', () => {
  const input = graph([
    {
      name: 'family',
      type: 'repeat',
      order: 1,
      label: 'Family',
      repeatMode: 'open',
    },
    {
      name: 'person',
      parent: 'family',
      type: 'repeat',
      order: 1,
      label: 'Person',
      repeatMode: 'fixed',
      repeatCount: 2,
    },
    { name: 'name', parent: 'person', type: 'text', order: 1, label: 'Name' },
  ]);
  const xml = renderXForm(
    input,
    new Map([['person', { repeatCountPath: '/data/family/_count_person' }]]),
    [{ path: '/data/family/_count_person', value: '2' }],
  );
  assert.match(
    xml,
    /<family jr:template="">\s+<_count_person>2<\/_count_person>\s+<person jr:template="">/,
  );
  assert.match(xml, /<repeat nodeset="\/data\/family">/);
  assert.match(
    xml,
    /<repeat nodeset="\/data\/family\/person" jr:count="\/data\/family\/_count_person" jr:noAddRemove="true\(\)">/,
  );
  assert.match(
    xml,
    /<bind nodeset="\/data\/family\/_count_person" type="int" readonly="true\(\)"\/>/,
  );
  assert.doesNotMatch(xml, /ref="\/data\/family\/_count_person"/);
});

void test('renderer uses dynamic count references without inventing a deletion or maximum policy', () => {
  const input = graph([
    { name: 'count', type: 'integer', order: 1, label: 'Count' },
    {
      name: 'item',
      type: 'repeat',
      order: 2,
      label: 'Item',
      repeatMode: 'from_answer',
      repeatSourceQuestion: 'count',
    },
    { name: 'value', parent: 'item', type: 'text', order: 1, label: 'Value' },
  ]);
  const xml = renderXForm(
    input,
    new Map([['item', { repeatCountPath: '/data/count' }]]),
    [],
  );
  assert.match(
    xml,
    /<repeat nodeset="\/data\/item" jr:count="\/data\/count" jr:noAddRemove="true\(\)">/,
  );
  assert.doesNotMatch(xml, /jr:max|delete|position\(/);
});

void test('renderer allowlist omits all author notes and source-only metadata while preserving collector hints', () => {
  const sentinel = 'AUTHOR_ONLY_SENTINEL_74338';
  const input = graph([
    {
      name: 'question',
      type: 'text',
      order: 1,
      label: 'Question',
      hint: 'Collector help',
      authorNotes: sentinel,
    },
    {
      name: 'section',
      type: 'section',
      order: 2,
      label: 'Section',
      authorNotes: sentinel,
    },
    {
      name: 'note',
      parent: 'section',
      type: 'note',
      order: 1,
      label: 'Visible note',
      authorNotes: sentinel,
    },
  ]);
  Object.assign(input.definition, {
    authorNotes: sentinel,
    internalMetadata: sentinel,
  });
  const xml = renderXForm(input, new Map(), []);
  assert.match(xml, /<hint>Collector help<\/hint>/);
  assert.match(xml, /<label>Visible note<\/label>/);
  assert.doesNotMatch(xml, new RegExp(sentinel));
  assert.doesNotMatch(
    xml,
    /authorNotes|internalMetadata|Question__c|Author_Notes/,
  );
});

void test('renderer keeps hidden values and calculations in the instance but not the body', () => {
  const input = graph([
    {
      name: 'hidden',
      type: 'text',
      order: 1,
      label: 'Not visible',
      hidden: true,
      defaultValue: '0',
    },
    {
      name: 'computed',
      type: 'calculate',
      order: 2,
      calculation: 'SOURCE_ONLY',
      defaultValue: 'false',
    },
    { name: 'reference', type: 'reference', order: 3, label: 'Reference' },
    { name: 'note', type: 'note', order: 4, label: 'Note' },
  ]);
  const xml = renderXForm(
    input,
    new Map([['computed', { calculation: '1 + 2' }]]),
    [],
  );
  assert.match(xml, /<hidden>0<\/hidden>/);
  assert.match(xml, /<computed>false<\/computed>/);
  assert.match(
    xml,
    /<bind nodeset="\/data\/computed" type="string" readonly="true\(\)" calculate="1 \+ 2"\/>/,
  );
  for (const name of ['reference', 'note']) {
    assert.match(
      xml,
      new RegExp(
        `<bind nodeset="/data/${name}" type="string" readonly="true\\(\\)"/>`,
      ),
    );
    assert.match(xml, new RegExp(`<input ref="/data/${name}">`));
  }
  const body = xml.slice(xml.indexOf('<h:body>'));
  assert.doesNotMatch(body, /\/hidden|\/computed|Not visible/);
  assert.doesNotMatch(xml, /SOURCE_ONLY|relevant="false\(\)"/);
});

void test('renderer encodes XML and XPath attributes separately and does not execute author markup', () => {
  const input = graph([
    {
      name: 'text',
      type: 'text',
      order: 1,
      label: '<script>& "quoted" café 漢字',
      hint: 'Line\r\nnext',
      defaultValue: '<&>\r\n',
      required: true,
      constraintMessage: 'Use "A" & B\nNext\tline',
      relevant: 'SOURCE_RELEVANT',
      constraint: 'SOURCE_CONSTRAINT',
    },
  ]);
  input.definition.form.title = 'A & B <title>';
  const logic = new Map<string, RenderLogic>([
    ['text', { relevant: "../a = 'x'", constraint: '. < 3 and . > 0' }],
  ]);
  const xml = renderXForm(input, logic, []);
  assert.match(xml, /<h:title>A &amp; B &lt;title&gt;<\/h:title>/);
  assert.match(xml, /<label>&lt;script&gt;&amp; "quoted" café 漢字<\/label>/);
  assert.match(xml, /<hint>Line&#13;\nnext<\/hint>/);
  assert.match(xml, /<text>&lt;&amp;&gt;&#13;\n<\/text>/);
  assert.match(xml, /required="true\(\)"/);
  assert.match(xml, /relevant="\.\.\/a = &apos;x&apos;"/);
  assert.match(xml, /constraint="\. &lt; 3 and \. &gt; 0"/);
  assert.match(
    xml,
    /jr:constraintMsg="Use &quot;A&quot; &amp; B&#10;Next&#9;line"/,
  );
  assert.doesNotMatch(xml, /<script>|SOURCE_RELEVANT|SOURCE_CONSTRAINT/);
});

void test('renderer emits scalar types and media controls using ODK names', () => {
  const definitions: Array<[QuestionDefinition['type'], string]> = [
    ['text', 'string'],
    ['text_long', 'string'],
    ['integer', 'int'],
    ['decimal', 'decimal'],
    ['date', 'date'],
    ['time', 'time'],
    ['datetime', 'dateTime'],
    ['geopoint', 'geopoint'],
    ['geotrace', 'geotrace'],
    ['geoshape', 'geoshape'],
    ['barcode', 'barcode'],
    ['photo', 'binary'],
    ['signature', 'binary'],
    ['audio', 'binary'],
    ['video', 'binary'],
    ['file', 'binary'],
  ];
  const input = graph(
    definitions.map(([type], index) => ({
      name: `q_${type}`,
      type,
      order: index + 1,
      label: type,
    })),
  );
  const xml = renderXForm(input, new Map(), []);
  for (const [type, dataType] of definitions)
    assert.match(
      xml,
      new RegExp(`<bind nodeset="/data/q_${type}" type="${dataType}"/>`),
    );
  assert.match(xml, /<input ref="\/data\/q_text_long" appearance="multiline">/);
  assert.match(
    xml,
    /<upload ref="\/data\/q_signature" appearance="signature" mediatype="image\/\*">/,
  );
  for (const [type, mediaType] of [
    ['photo', 'image'],
    ['audio', 'audio'],
    ['video', 'video'],
  ])
    assert.ok(
      xml.includes(`<upload ref="/data/q_${type}" mediatype="${mediaType}/*">`),
    );
  assert.ok(xml.includes('<upload ref="/data/q_file" mediatype="*/*">'));
});

void test('renderer scalar values survive XML newline and attribute whitespace normalization', () => {
  // The XML scalar rules only, not an XML document parser: literal newlines are
  // normalized before entity references are expanded, attributes additionally
  // normalize whitespace. One-pass expansion must not reinterpret escaped text.
  function parsedScalar(encoded: string, isAttribute: boolean): string {
    let normalized = encoded.replace(/\r\n?/g, '\n');
    if (isAttribute) normalized = normalized.replace(/[\t\n]/g, ' ');
    const entities: Record<string, string> = {
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
    };
    return normalized.replace(
      /&(#\d+|amp|lt|gt|quot|apos);/g,
      (_match: string, entity: string) =>
        entity.startsWith('#')
          ? String.fromCodePoint(Number(entity.slice(1)))
          : entities[entity]!,
    );
  }
  const literal = 'before\r\nafter\rlast\n\t café & < literal &#13;';
  const constraint = "regex(., 'before\r\nafter\rlast\n\t & <')";
  const input = graph([
    {
      name: 'answer',
      type: 'text',
      order: 1,
      label: literal,
      hint: literal,
      defaultValue: literal,
      constraintMessage: literal,
    },
  ]);
  const xml = renderXForm(input, new Map([['answer', { constraint }]]), []);
  const stored = /<answer>([\s\S]*?)<\/answer>/.exec(xml)?.[1];
  const label = /<label>([\s\S]*?)<\/label>/.exec(xml)?.[1];
  const hint = /<hint>([\s\S]*?)<\/hint>/.exec(xml)?.[1];
  const expression = / constraint="([^"]*)"/.exec(xml)?.[1];
  const message = / jr:constraintMsg="([^"]*)"/.exec(xml)?.[1];
  for (const value of [stored, label, hint]) {
    assert.equal(typeof value, 'string');
    assert.equal(parsedScalar(value!, false), literal);
  }
  assert.equal(typeof expression, 'string');
  assert.equal(typeof message, 'string');
  assert.equal(parsedScalar(expression!, true), constraint);
  assert.equal(parsedScalar(message!, true), literal);
  assert.doesNotMatch(expression!, /[\r\n\t]/);
  assert.match(expression!, /&#13;&#10;/);
  assert.match(expression!, /&#9;/);
  assert.match(stored!, /&amp;#13;/);
  // Negative controls prove the reference normalization is not a no-op.
  assert.notEqual(parsedScalar(literal, false), literal);
  assert.notEqual(parsedScalar(literal, true), literal);
});

void test('renderer emits stable ordered choices without mutating the supplied list', () => {
  const choices = [
    { value: 'z', label: 'Last', order: 2 },
    { value: 'b', label: 'Second', order: 1 },
    { value: 'a', label: 'First & best', order: 1 },
  ];
  const input = graph(
    [
      {
        name: 'one',
        type: 'select_one',
        order: 1,
        label: 'One',
        choiceList: 'options',
      },
      {
        name: 'many',
        type: 'select_multiple',
        order: 2,
        label: 'Many',
        choiceList: 'options',
      },
    ],
    [{ name: 'options', choices }],
  );
  const xml = renderXForm(input, new Map(), []);
  assert.match(xml, /<bind nodeset="\/data\/one" type="select1"\/>/);
  assert.match(xml, /<bind nodeset="\/data\/many" type="select"\/>/);
  assert.match(xml, /<select1 ref="\/data\/one">/);
  assert.match(xml, /<select ref="\/data\/many">/);
  assert.match(xml, /<label>First &amp; best<\/label>/);
  assert.ok(xml.indexOf('<value>a</value>') < xml.indexOf('<value>b</value>'));
  assert.ok(xml.indexOf('<value>b</value>') < xml.indexOf('<value>z</value>'));
  assert.deepEqual(
    choices.map((choice) => choice.value),
    ['z', 'b', 'a'],
  );
  assert.equal(renderXForm(input, new Map(), []), xml);
});

void test('renderer includes runtime instance ID metadata without compile-time randomness or timestamps', () => {
  const input = graph([
    { name: 'q', type: 'text', order: 1, label: 'Question' },
  ]);
  const xml = renderXForm(input, new Map(), []);
  assert.match(xml, /<data xmlns="" id="synthetic_form" version="1">/);
  assert.match(xml, /xmlns:orx="http:\/\/openrosa.org\/xforms"/);
  assert.match(xml, /<orx:meta>\s+<orx:instanceID\/>\s+<\/orx:meta>/);
  assert.doesNotMatch(xml, /<meta>|<instanceID/);
  assert.match(
    xml,
    /<bind nodeset="\/data\/orx:meta\/orx:instanceID" type="string" readonly="true\(\)" calculate="once\(concat\(&apos;uuid:&apos;, uuid\(\)\)\)"\/>/,
  );
  assert.equal(xml.split('<orx:instanceID/>').length - 1, 1);
  assert.ok(xml.endsWith('</h:html>\n'));
  assert.equal(xml.includes('\r'), false);
  assert.equal(renderXForm(input, new Map(), []), xml);
});
