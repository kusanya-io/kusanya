/** Decode bounded JSON and construct the portable question tree, without I/O. */
import { types } from 'node:util';
import {
  CompileError,
  isContainer,
  questionTypes,
  type DefinitionGraph,
  type FormDefinition,
  type QuestionNode,
} from './types.js';

export const portableName = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const fields = {
  text: [
    'name',
    'parent',
    'label',
    'hint',
    'authorNotes',
    'defaultValue',
    'calculation',
    'constraint',
    'constraintMessage',
    'regex',
    'regexExample',
    'relevant',
    'appearance',
    'choiceList',
    'repeatSourceQuestion',
    'prefillSource',
    'validationScript',
  ],
  boolean: [
    'required',
    'readOnly',
    'hidden',
    'samePage',
    'repeatAsTable',
    'requireLivePhoto',
  ],
  number: [
    'order',
    'minimum',
    'maximum',
    'repeatCount',
    'repeatMax',
    'cascadeLevel',
    'mediaMaxSeconds',
  ],
};

export function validXmlText(text: string): boolean {
  for (const char of text) {
    const point = char.codePointAt(0)!;
    if (
      (point < 0x20 && ![9, 10, 13].includes(point)) ||
      point === 0xfffe ||
      point === 0xffff ||
      (point >= 0xd800 && point <= 0xdfff)
    )
      return false;
  }
  return true;
}

export function decodeDefinition(
  input: unknown,
  location: (path: string) => void,
): FormDefinition {
  let textUnits = 0;
  function record(
    value: unknown,
    allowed: readonly string[],
  ): Record<string, unknown> {
    if (
      !value ||
      typeof value !== 'object' ||
      types.isProxy(value) ||
      Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    )
      throw new CompileError('INPUT_SHAPE');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).length > allowed.length ||
      Object.getOwnPropertySymbols(value).length
    )
      throw new CompileError('INPUT_SHAPE');
    for (const key of Object.keys(descriptors)) {
      if (!allowed.includes(key) || !Object.hasOwn(descriptors[key]!, 'value'))
        throw new CompileError('INPUT_SHAPE');
    }
    return value as Record<string, unknown>;
  }
  function text(value: unknown, required = false, limit = 32768): void {
    if (value === undefined && !required) return;
    if (
      typeof value !== 'string' ||
      value.length > limit ||
      !validXmlText(value) ||
      (required && value.trim().length === 0)
    )
      throw new CompileError('INPUT_TEXT');
    textUnits += value.length;
    if (textUnits > 1_000_000) throw new CompileError('INPUT_LIMIT');
  }
  function number(value: unknown, required = false, integer = false): void {
    if (value === undefined && !required) return;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      Math.abs(value) > 1e12 ||
      (integer && (!Number.isSafeInteger(value) || value <= 0))
    )
      throw new CompileError('INPUT_NUMBER');
  }
  function array(value: unknown, limit: number): unknown[] {
    if (
      !value ||
      typeof value !== 'object' ||
      types.isProxy(value) ||
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > limit
    )
      throw new CompileError('INPUT_LIMIT');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Object.getOwnPropertySymbols(value).length ||
      Object.keys(descriptors).length !== value.length + 1
    )
      throw new CompileError('INPUT_SHAPE');
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(descriptors[String(index)] ?? {}, 'value'))
        throw new CompileError('INPUT_SHAPE');
    }
    return value as unknown[];
  }
  function enumeration(
    value: unknown,
    allowed: readonly string[],
    optional = false,
  ): void {
    if (value === undefined && optional) return;
    if (typeof value !== 'string' || !allowed.includes(value))
      throw new CompileError('INPUT_ENUM');
  }
  location('definition');
  const root = record(input, [
    'schemaVersion',
    'form',
    'questions',
    'choiceLists',
    'skipRules',
  ]);
  if (root.schemaVersion !== 1) throw new CompileError('SCHEMA_VERSION');
  location('form');
  const form = record(root.form, ['key', 'title', 'version']);
  text(form.key, true, 80);
  text(form.title, true);
  number(form.version, true, true);
  if (!portableName.test(form.key as string))
    throw new CompileError('FORM_KEY');
  const questions = array(root.questions, 500);
  if (questions.length === 0) throw new CompileError('EMPTY_FORM');
  for (const [index, value] of questions.entries()) {
    location(`questions[${index}]`);
    const question = record(value, [
      ...fields.text,
      ...fields.boolean,
      ...fields.number,
      'type',
      'repeatMode',
    ]);
    for (const name of fields.text) text(question[name], name === 'name');
    for (const name of fields.boolean) {
      if (question[name] !== undefined && typeof question[name] !== 'boolean')
        throw new CompileError('INPUT_BOOLEAN');
    }
    for (const name of fields.number)
      number(
        question[name],
        name === 'order',
        !['minimum', 'maximum'].includes(name),
      );
    enumeration(question.type, questionTypes);
    enumeration(question.repeatMode, ['fixed', 'from_answer', 'open'], true);
  }
  const lists = array(root.choiceLists, 500);
  let totalChoices = 0;
  for (const [index, value] of lists.entries()) {
    location(`choiceLists[${index}]`);
    const list = record(value, ['name', 'choices']);
    text(list.name, true, 80);
    const choices = array(list.choices, 5000);
    totalChoices += choices.length;
    if (totalChoices > 5000) throw new CompileError('INPUT_LIMIT');
    for (const [choiceIndex, choiceValue] of choices.entries()) {
      location(`choiceLists[${index}].choices[${choiceIndex}]`);
      const choice = record(choiceValue, [
        'value',
        'label',
        'order',
        'filterValue',
        'score',
      ]);
      text(choice.value, true, 255);
      text(choice.label, true);
      text(choice.filterValue, false, 255);
      number(choice.order, true, true);
      number(choice.score);
    }
  }
  for (const [index, value] of array(root.skipRules, 2000).entries()) {
    location(`skipRules[${index}]`);
    const rule = record(value, [
      'question',
      'sourceQuestion',
      'operator',
      'value',
      'valueTo',
      'join',
      'action',
    ]);
    text(rule.question, true, 80);
    text(rule.sourceQuestion, true, 80);
    text(rule.value, false, 255);
    text(rule.valueTo, false, 255);
    enumeration(rule.operator, [
      'answered',
      'is',
      'is_not',
      'less_than',
      'greater_than',
      'in_range',
      'contains',
    ]);
    enumeration(rule.join, ['all', 'any']);
    enumeration(rule.action, ['show', 'hide']);
  }
  // Every property has been checked; extra data and executable accessors are refused.
  return input as FormDefinition;
}

export function buildGraph(
  definition: FormDefinition,
  location: (path: string) => void,
): DefinitionGraph {
  const byName = new Map<string, QuestionNode>();
  for (const [index, question] of definition.questions.entries()) {
    location(`questions[${index}]`);
    if (
      question.name.length > 80 ||
      !portableName.test(question.name) ||
      /^(xml|_ksny_)/i.test(question.name) ||
      ['data', 'meta', 'instanceID'].includes(question.name)
    )
      throw new CompileError('QUESTION_NAME');
    if (byName.has(question.name)) throw new CompileError('DUPLICATE_QUESTION');
    byName.set(question.name, {
      definition: question,
      index,
      path: '',
      parent: undefined,
      children: [],
      repeats: [],
    });
  }
  const nodes = [...byName.values()];
  for (const node of nodes) {
    location(`questions[${node.index}]`);
    const ancestors: QuestionNode[] = [];
    const visited = new Set([node.definition.name]);
    let parentName = node.definition.parent;
    while (parentName !== undefined) {
      const parent = byName.get(parentName);
      if (!parent || !isContainer(parent.definition.type))
        throw new CompileError('QUESTION_PARENT');
      if (visited.has(parentName)) throw new CompileError('QUESTION_CYCLE');
      visited.add(parentName);
      ancestors.unshift(parent);
      if (ancestors.length > 32) throw new CompileError('TREE_DEPTH');
      parentName = parent.definition.parent;
    }
    node.parent = ancestors.at(-1);
    node.path = `/data/${[...ancestors.map((entry) => entry.definition.name), node.definition.name].join('/')}`;
    node.repeats = ancestors
      .filter((entry) => entry.definition.type === 'repeat')
      .map((entry) => entry.definition.name);
    node.parent?.children.push(node);
  }
  const compare = (a: QuestionNode, b: QuestionNode): number =>
    a.definition.order - b.definition.order ||
    (a.definition.name < b.definition.name
      ? -1
      : a.definition.name > b.definition.name
        ? 1
        : 0);
  for (const node of nodes) node.children.sort(compare);
  const roots = nodes.filter((node) => !node.parent).sort(compare);
  const lists = new Map<string, FormDefinition['choiceLists'][number]>();
  for (const [index, list] of definition.choiceLists.entries()) {
    location(`choiceLists[${index}]`);
    if (!portableName.test(list.name) || lists.has(list.name))
      throw new CompileError('CHOICE_LIST_NAME');
    const values = new Set<string>();
    for (const choice of list.choices) {
      if (/\s/u.test(choice.value) || values.has(choice.value))
        throw new CompileError('CHOICE_VALUE');
      if (choice.filterValue || choice.score !== undefined)
        throw new CompileError('UNSUPPORTED_CHOICE_OPTION');
      values.add(choice.value);
    }
    lists.set(list.name, list);
  }
  const orderedNodes: QuestionNode[] = [];
  const walk = (node: QuestionNode): void => {
    orderedNodes.push(node);
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  return { definition, nodes: orderedNodes, roots, byName, lists };
}

/** Scalar references may use root, ancestor-repeat or the same repeat instance only. */
export function scopedReference(
  target: QuestionNode,
  source: QuestionNode,
): string {
  if (source.repeats.some((name, index) => name !== target.repeats[index]))
    throw new CompileError('REFERENCE_SCOPE');
  if (source.repeats.length === 0) return source.path;
  const from = target.path.split('/');
  const to = source.path.split('/');
  let shared = 0;
  while (
    shared < from.length &&
    shared < to.length &&
    from[shared] === to[shared]
  )
    shared++;
  return (
    [
      ...Array<string>(from.length - shared).fill('..'),
      ...to.slice(shared),
    ].join('/') || '.'
  );
}
