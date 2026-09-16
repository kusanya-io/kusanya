import type { DefinitionGraph, QuestionNode, QuestionType } from './types.js';

export interface RenderLogic {
  relevant?: string;
  constraint?: string;
  calculation?: string;
  repeatCountPath?: string;
}

interface CountNode {
  readonly path: string;
  readonly value: string;
}

const dataTypes: Partial<Record<QuestionType, string>> = {
  note: 'string',
  text: 'string',
  text_long: 'string',
  integer: 'int',
  decimal: 'decimal',
  select_one: 'select1',
  select_multiple: 'select',
  date: 'date',
  time: 'time',
  datetime: 'dateTime',
  geopoint: 'geopoint',
  geotrace: 'geotrace',
  geoshape: 'geoshape',
  photo: 'binary',
  signature: 'binary',
  audio: 'binary',
  video: 'binary',
  file: 'binary',
  barcode: 'barcode',
  calculate: 'string',
  reference: 'string',
};

const mediaTypes: Partial<Record<QuestionType, string>> = {
  photo: 'image/*',
  signature: 'image/*',
  audio: 'audio/*',
  video: 'video/*',
  file: '*/*',
};

function text(value: string): string {
  // XML normalizes literal CR/CRLF before parsing; a reference preserves the CR.
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\r', '&#13;');
}

function attribute(value: string): string {
  // Literal attribute whitespace becomes spaces; references retain its value.
  return text(value)
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('\n', '&#10;')
    .replaceAll('\t', '&#9;');
}

function attr(name: string, value: string | undefined): string {
  return value === undefined ? '' : ` ${name}="${attribute(value)}"`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Render only validated, explicitly allowed collector fields, never source JSON. */
export function renderXForm(
  graph: DefinitionGraph,
  logic: Map<string, RenderLogic>,
  counts: readonly CountNode[],
): string {
  const lines: string[] = [];
  const line = (depth: number, value: string): void => {
    lines.push(`${'  '.repeat(depth)}${value}`);
  };
  const orderedCounts = [...counts].sort((a, b) => compareText(a.path, b.path));
  const countsByParent = new Map<string, CountNode[]>();
  for (const count of orderedCounts) {
    const parent = count.path.slice(0, count.path.lastIndexOf('/'));
    const siblings = countsByParent.get(parent) ?? [];
    siblings.push(count);
    countsByParent.set(parent, siblings);
  }
  const renderCounts = (parent: string, depth: number): void => {
    for (const count of countsByParent.get(parent) ?? []) {
      const name = count.path.slice(count.path.lastIndexOf('/') + 1);
      line(depth, `<${name}>${text(count.value)}</${name}>`);
    }
  };
  const instance = (node: QuestionNode, depth: number): void => {
    const question = node.definition;
    const template = question.type === 'repeat' ? ' jr:template=""' : '';
    if (question.type === 'section' || question.type === 'repeat') {
      line(depth, `<${question.name}${template}>`);
      renderCounts(node.path, depth + 1);
      for (const child of node.children) instance(child, depth + 1);
      line(depth, `</${question.name}>`);
    } else {
      line(
        depth,
        `<${question.name}>${text(question.defaultValue ?? '')}</${question.name}>`,
      );
    }
  };
  const labelAndHint = (node: QuestionNode, depth: number): void => {
    if (node.definition.label !== undefined)
      line(depth, `<label>${text(node.definition.label)}</label>`);
    if (node.definition.hint !== undefined)
      line(depth, `<hint>${text(node.definition.hint)}</hint>`);
  };
  const control = (node: QuestionNode, depth: number): void => {
    const question = node.definition;
    if (question.hidden || question.type === 'calculate') return;
    const appearance =
      question.type === 'signature'
        ? 'signature'
        : (question.appearance ??
          (question.type === 'text_long' ? 'multiline' : undefined));
    if (question.type === 'section') {
      line(
        depth,
        `<group${attr('ref', node.path)}${attr('appearance', appearance)}>`,
      );
      labelAndHint(node, depth + 1);
      for (const child of node.children) control(child, depth + 1);
      line(depth, '</group>');
    } else if (question.type === 'repeat') {
      line(depth, `<group${attr('ref', node.path)}>`);
      labelAndHint(node, depth + 1);
      const countPath = logic.get(question.name)?.repeatCountPath;
      line(
        depth + 1,
        `<repeat${attr('nodeset', node.path)}${attr('appearance', appearance)}${attr('jr:count', countPath)}${attr('jr:noAddRemove', countPath === undefined ? undefined : 'true()')}>`,
      );
      for (const child of node.children) control(child, depth + 2);
      line(depth + 1, '</repeat>');
      line(depth, '</group>');
    } else {
      const mediaType = mediaTypes[question.type];
      const tag =
        question.type === 'select_one'
          ? 'select1'
          : question.type === 'select_multiple'
            ? 'select'
            : mediaType === undefined
              ? 'input'
              : 'upload';
      line(
        depth,
        `<${tag}${attr('ref', node.path)}${attr('appearance', appearance)}${attr('mediatype', mediaType)}>`,
      );
      labelAndHint(node, depth + 1);
      if (question.choiceList !== undefined) {
        const choices = graph.lists.get(question.choiceList)?.choices ?? [];
        for (const choice of [...choices].sort(
          (a, b) => a.order - b.order || compareText(a.value, b.value),
        )) {
          line(depth + 1, '<item>');
          line(depth + 2, `<label>${text(choice.label)}</label>`);
          line(depth + 2, `<value>${text(choice.value)}</value>`);
          line(depth + 1, '</item>');
        }
      }
      line(depth, `</${tag}>`);
    }
  };

  line(0, '<?xml version="1.0" encoding="UTF-8"?>');
  line(
    0,
    '<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml" xmlns:jr="http://openrosa.org/javarosa" xmlns:orx="http://openrosa.org/xforms" xmlns:odk="http://www.opendatakit.org/xforms" xmlns:xsd="http://www.w3.org/2001/XMLSchema">',
  );
  line(1, '<h:head>');
  line(2, `<h:title>${text(graph.definition.form.title)}</h:title>`);
  line(2, '<model>');
  line(3, '<instance>');
  line(
    4,
    `<data xmlns=""${attr('id', graph.definition.form.key)}${attr('version', String(graph.definition.form.version))}>`,
  );
  renderCounts('/data', 5);
  for (const root of graph.roots) instance(root, 5);
  // The data tree has no namespace; OpenRosa metadata must be explicitly qualified.
  line(5, '<orx:meta>');
  line(6, '<orx:instanceID/>');
  line(5, '</orx:meta>');
  line(4, '</data>');
  line(3, '</instance>');
  for (const count of orderedCounts)
    line(
      3,
      `<bind${attr('nodeset', count.path)} type="int" readonly="true()"/>`,
    );
  for (const node of graph.nodes) {
    const question = node.definition;
    const prepared = logic.get(question.name);
    const readonly =
      question.readOnly ||
      question.type === 'note' ||
      question.type === 'calculate' ||
      question.type === 'reference';
    line(
      3,
      `<bind${attr('nodeset', node.path)}${attr('type', dataTypes[question.type])}${attr('required', question.required ? 'true()' : undefined)}${attr('readonly', readonly ? 'true()' : undefined)}${attr('relevant', prepared?.relevant)}${attr('constraint', prepared?.constraint)}${attr('jr:constraintMsg', prepared?.constraint === undefined ? undefined : question.constraintMessage)}${attr('calculate', prepared?.calculation)}/>`,
    );
  }
  line(
    3,
    `<bind nodeset="/data/orx:meta/orx:instanceID" type="string" readonly="true()"${attr('calculate', "once(concat('uuid:', uuid()))")}/>`,
  );
  line(2, '</model>');
  line(1, '</h:head>');
  line(1, '<h:body>');
  for (const root of graph.roots) control(root, 2);
  line(1, '</h:body>');
  line(0, '</h:html>');
  return `${lines.join('\n')}\n`;
}
