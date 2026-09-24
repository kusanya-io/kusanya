/** Pure submission-tree cardinality policy. No XML parsing, storage or I/O. */
import { types } from 'node:util';
import { portableName, validXmlText } from '../compiler/definition.js';
import { prepareForm } from '../compiler/prepare.js';
import type {
  DefinitionGraph,
  Diagnostic,
  QuestionNode,
} from '../compiler/types.js';

export const dynamicRepeatCardinalityPolicy = 'submitted-count-v1' as const;

export type SubmissionNode =
  | { readonly name: string; readonly value: string }
  | { readonly name: string; readonly children: readonly SubmissionNode[] };

export interface ExcludedRepeatInstances {
  readonly repeatPath: string;
  readonly parentInstances: readonly number[];
  readonly excluded: number;
}

export type RepeatCardinalityResult =
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }
  | {
      readonly ok: true;
      readonly policy: typeof dynamicRepeatCardinalityPolicy;
      readonly submission: SubmissionNode;
      readonly excludedInstances: readonly ExcludedRepeatInstances[];
    };

type MutableSubmissionNode =
  | { name: string; value: string; location: string }
  | {
      name: string;
      children: MutableSubmissionNode[];
      location: string;
    };

const maxNodes = 100_000;
const maxTextUnits = 8_000_000;
const maxValueUnits = 1_000_000;
const maxDepth = 32;

class CardinalityFailure extends Error {
  constructor(
    readonly code: string,
    readonly location: string,
  ) {
    super(code);
    this.name = 'CardinalityFailure';
  }
}

function immutableDiagnostics(
  diagnostics: readonly Diagnostic[],
): readonly Diagnostic[] {
  return Object.freeze(
    diagnostics.map(({ code, location }) => Object.freeze({ code, location })),
  );
}

function ordinaryRecord(value: unknown, location: string): object {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new CardinalityFailure('SUBMISSION_SHAPE', location);
  return value;
}

function ordinaryArray(value: unknown, location: string): unknown[] {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    throw new CardinalityFailure('SUBMISSION_SHAPE', location);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string') ||
    Object.keys(descriptors).length !== value.length + 1
  )
    throw new CardinalityFailure('SUBMISSION_SHAPE', location);
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value'))
      throw new CardinalityFailure('SUBMISSION_SHAPE', location);
  }
  return value;
}

function decodeSubmission(input: unknown): MutableSubmissionNode {
  let nodes = 0;
  let textUnits = 0;
  const decode = (
    value: unknown,
    location: string,
    depth: number,
  ): MutableSubmissionNode => {
    nodes++;
    if (nodes > maxNodes || depth > maxDepth)
      throw new CardinalityFailure('SUBMISSION_LIMIT', location);
    ordinaryRecord(value, location);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string'))
      throw new CardinalityFailure('SUBMISSION_SHAPE', location);
    const keys = Object.keys(descriptors);
    const hasName = Object.hasOwn(descriptors, 'name');
    const hasChildren = Object.hasOwn(descriptors, 'children');
    const hasValue = Object.hasOwn(descriptors, 'value');
    if (
      keys.length !== 2 ||
      !hasName ||
      hasChildren === hasValue ||
      keys.some((key) => !Object.hasOwn(descriptors[key]!, 'value'))
    )
      throw new CardinalityFailure('SUBMISSION_SHAPE', location);
    const name = descriptors.name!.value as unknown;
    if (
      typeof name !== 'string' ||
      name.length > 80 ||
      !portableName.test(name)
    )
      throw new CardinalityFailure('SUBMISSION_NAME', location);
    textUnits += name.length;
    if (hasValue) {
      const submittedValue = descriptors.value!.value as unknown;
      if (
        typeof submittedValue !== 'string' ||
        submittedValue.length > maxValueUnits ||
        !validXmlText(submittedValue)
      )
        throw new CardinalityFailure('SUBMISSION_VALUE', location);
      textUnits += submittedValue.length;
      if (textUnits > maxTextUnits)
        throw new CardinalityFailure('SUBMISSION_LIMIT', location);
      return { name, value: submittedValue, location };
    }
    const children = ordinaryArray(
      descriptors.children!.value,
      `${location}.children`,
    ).map((child, index) =>
      decode(child, `${location}.children[${index}]`, depth + 1),
    );
    if (textUnits > maxTextUnits)
      throw new CardinalityFailure('SUBMISSION_LIMIT', location);
    return { name, children, location };
  };
  const root = decode(input, 'submission', 0);
  if (root.name !== 'data' || !('children' in root))
    throw new CardinalityFailure('SUBMISSION_ROOT', 'submission');
  return root;
}

const contextKey = (
  node: QuestionNode,
  context: ReadonlyMap<string, number>,
): string =>
  `${node.definition.name}|${node.repeats
    .map((repeat) => String(context.get(repeat) ?? 0))
    .join('.')}`;

function freezeNode(node: MutableSubmissionNode): SubmissionNode {
  if ('value' in node)
    return Object.freeze({ name: node.name, value: node.value });
  return Object.freeze({
    name: node.name,
    children: Object.freeze(node.children.map(freezeNode)),
  });
}

/**
 * Apply the ADR 0029 submitted-count rule to an already parsed submission tree.
 * Callers retain the raw XML/tree separately; this function clones and never mutates it.
 */
export function normalizeRepeatCardinality(
  definitionInput: unknown,
  submissionInput: unknown,
): RepeatCardinalityResult {
  const prepared = prepareForm(definitionInput);
  if (!prepared.ok)
    return Object.freeze({
      ok: false,
      diagnostics: immutableDiagnostics(prepared.diagnostics),
    });
  try {
    const root = decodeSubmission(submissionInput);
    const answers = new Map<string, MutableSubmissionNode[]>();
    const graph: DefinitionGraph = prepared.graph;
    const definitionFor = (name: string): QuestionNode | undefined =>
      graph.byName.get(name);
    const repeatsByParent = new Map<QuestionNode | undefined, QuestionNode[]>();
    for (const candidate of graph.nodes) {
      if (candidate.definition.type !== 'repeat') continue;
      const repeats = repeatsByParent.get(candidate.parent) ?? [];
      repeats.push(candidate);
      repeatsByParent.set(candidate.parent, repeats);
    }

    const index = (
      node: MutableSubmissionNode,
      parent: QuestionNode | undefined,
      context: ReadonlyMap<string, number>,
      knownPlacement = true,
    ): void => {
      if (!('children' in node)) return;
      const occurrences = new Map<string, number>();
      const seenSingletons = new Set<string>();
      for (const child of node.children) {
        const definition = definitionFor(child.name);
        if (!definition) {
          index(child, undefined, context, false);
          continue;
        }
        if (!knownPlacement || definition.parent !== parent)
          throw new CardinalityFailure(
            'SUBMISSION_QUESTION_PLACEMENT',
            child.location,
          );
        const container = ['section', 'repeat'].includes(
          definition.definition.type,
        );
        if (container !== 'children' in child)
          throw new CardinalityFailure('SUBMISSION_SHAPE', child.location);
        if (definition.definition.type !== 'repeat') {
          if (seenSingletons.has(definition.definition.name))
            throw new CardinalityFailure(
              'SUBMISSION_DUPLICATE',
              child.location,
            );
          seenSingletons.add(definition.definition.name);
        }
        const nextContext = new Map(context);
        if (definition.definition.type === 'repeat') {
          const ordinal =
            (occurrences.get(definition.definition.name) ?? 0) + 1;
          occurrences.set(definition.definition.name, ordinal);
          nextContext.set(definition.definition.name, ordinal);
        } else if (!container) {
          const key = contextKey(definition, context);
          const values = answers.get(key) ?? [];
          values.push(child);
          answers.set(key, values);
        }
        index(child, definition, nextContext, knownPlacement);
      }
    };
    index(root, undefined, new Map());

    const excluded: ExcludedRepeatInstances[] = [];
    const normalize = (
      node: MutableSubmissionNode,
      parent: QuestionNode | undefined,
      context: ReadonlyMap<string, number>,
      knownScope = true,
    ): MutableSubmissionNode => {
      if (!('children' in node)) return node;
      if (!knownScope)
        return {
          name: node.name,
          children: node.children.map((child) =>
            normalize(child, undefined, context, false),
          ),
          location: node.location,
        };
      const groups = new Map<string, MutableSubmissionNode[]>();
      for (const child of node.children) {
        const definition = definitionFor(child.name);
        if (definition?.definition.type === 'repeat') {
          const group = groups.get(child.name) ?? [];
          group.push(child);
          groups.set(child.name, group);
        }
      }
      const limits = new Map<string, number>();
      for (const repeat of repeatsByParent.get(parent) ?? []) {
        const name = repeat.definition.name;
        const instances = groups.get(name) ?? [];
        if (repeat.definition.repeatMode !== 'from_answer') {
          limits.set(name, instances.length);
          continue;
        }
        const source = definitionFor(
          repeat.definition.repeatSourceQuestion ?? '',
        );
        if (!source)
          throw new CardinalityFailure(
            'SUBMISSION_REPEAT_COUNT',
            node.location,
          );
        const submitted = answers.get(contextKey(source, context)) ?? [];
        const submittedCount = submitted[0];
        if (
          submitted.length !== 1 ||
          !submittedCount ||
          !('value' in submittedCount)
        )
          throw new CardinalityFailure(
            'SUBMISSION_REPEAT_COUNT',
            submittedCount?.location ?? node.location,
          );
        const countText = submittedCount.value;
        if (!/^(?:0|[1-9][0-9]*)$/.test(countText))
          throw new CardinalityFailure(
            'SUBMISSION_REPEAT_COUNT',
            submittedCount.location,
          );
        const count = Number(countText);
        const ceiling = repeat.definition.repeatMax ?? 1000;
        if (!Number.isSafeInteger(count) || count > ceiling)
          throw new CardinalityFailure(
            'SUBMISSION_REPEAT_COUNT',
            submittedCount.location,
          );
        if (instances.length < count)
          throw new CardinalityFailure(
            'SUBMISSION_REPEAT_DEFICIT',
            node.location,
          );
        limits.set(name, count);
        if (instances.length > count)
          excluded.push(
            Object.freeze({
              repeatPath: repeat.path,
              parentInstances: Object.freeze(
                repeat.repeats.map((ancestor) => context.get(ancestor) ?? 0),
              ),
              excluded: instances.length - count,
            }),
          );
      }
      const ordinals = new Map<string, number>();
      const children: MutableSubmissionNode[] = [];
      for (const child of node.children) {
        const definition = definitionFor(child.name);
        let nextContext = context;
        if (
          definition?.definition.type === 'repeat' &&
          definition.parent === parent
        ) {
          const ordinal = (ordinals.get(child.name) ?? 0) + 1;
          ordinals.set(child.name, ordinal);
          if (ordinal > (limits.get(child.name) ?? ordinal)) continue;
          const repeatContext = new Map(context);
          repeatContext.set(child.name, ordinal);
          nextContext = repeatContext;
        }
        children.push(
          normalize(child, definition, nextContext, definition !== undefined),
        );
      }
      return { name: node.name, children, location: node.location };
    };

    const normalizedRoot = normalize(root, undefined, new Map());
    const repeatOrder = new Map(
      graph.nodes.map((node, index) => [node.path, index] as const),
    );
    excluded.sort(
      (left, right) =>
        (repeatOrder.get(left.repeatPath) ?? Number.MAX_SAFE_INTEGER) -
        (repeatOrder.get(right.repeatPath) ?? Number.MAX_SAFE_INTEGER),
    );
    const normalized = freezeNode(normalizedRoot);
    return Object.freeze({
      ok: true,
      policy: dynamicRepeatCardinalityPolicy,
      submission: normalized,
      excludedInstances: Object.freeze(excluded),
    });
  } catch (error) {
    if (error instanceof CardinalityFailure)
      return Object.freeze({
        ok: false,
        diagnostics: immutableDiagnostics([
          { code: error.code, location: error.location },
        ]),
      });
    throw error;
  }
}
