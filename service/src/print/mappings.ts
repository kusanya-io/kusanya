/** Portable review snapshots only; these checks do not approve publication. */
import { types } from 'node:util';
import { portableName, validXmlText } from '../compiler/definition.js';
import {
  CompileError,
  isAnswerable,
  type DefinitionGraph,
} from '../compiler/types.js';

const transforms = [
  'none',
  'picklist_match',
  'multi_select_join',
  'lookup_by_external_id',
  'date_only',
  'boolean_yes_no',
  'number',
  'text_truncate',
  'geopoint_lat',
  'geopoint_lng',
  'geopoint_accuracy',
  'file_url',
] as const;
export type PrintTransform = (typeof transforms)[number];

export type PrintFieldMapping = {
  targetField: string;
  transform?: PrintTransform;
} & (
  | { sourceKind: 'question'; question: string; constantValue?: never }
  | { sourceKind: 'constant'; constantValue: string | null; question?: never }
);

export interface PrintMapping {
  key: string;
  label?: string;
  order: number;
  kind: 'main' | 'repeat' | 'reference';
  targetObject: string;
  repeatQuestion?: string;
  recordType?: string;
  parentMapping?: string;
  parentLookupField?: string;
  matchingField?: string;
  upsertExternalIdField?: string;
  collectorField?: string;
  submissionField?: string;
  fields: PrintFieldMapping[];
}

export interface PrintMappingBundle {
  schemaVersion: 1;
  mappings: PrintMapping[];
}

// ADR 0013's lexical contract says nothing about schema existence or access.
const apiName = /^[A-Za-z][A-Za-z0-9]*(?:_{1,2}[A-Za-z0-9]+)*$/;
const targetProperties = [
  'targetObject',
  'recordType',
  'parentLookupField',
  'matchingField',
  'upsertExternalIdField',
  'collectorField',
  'submissionField',
] as const;

export function decodePrintMappings(
  input: unknown,
  graph: DefinitionGraph,
  at: (path: string) => void,
): PrintMappingBundle {
  let textUnits = 0;
  let fieldCount = 0;

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
      throw new CompileError('PRINT_INPUT_SHAPE');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > allowed.length)
      throw new CompileError('PRINT_INPUT_SHAPE');
    // Read descriptor values into a detached, prototype-free snapshot. Never
    // evaluate a supplied accessor, iterator, toJSON, or proxy trap.
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (
        typeof key !== 'string' ||
        !allowed.includes(key) ||
        !Object.hasOwn(descriptors[key]!, 'value')
      )
        throw new CompileError('PRINT_INPUT_SHAPE');
      result[key] = descriptors[key]!.value as unknown;
    }
    return result;
  }

  function array(value: unknown, limit: number): unknown[] {
    if (
      !value ||
      typeof value !== 'object' ||
      types.isProxy(value) ||
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    )
      throw new CompileError('PRINT_INPUT_SHAPE');
    if (value.length > limit) throw new CompileError('PRINT_INPUT_LIMIT');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== value.length + 1)
      throw new CompileError('PRINT_INPUT_SHAPE');
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, 'value'))
        throw new CompileError('PRINT_INPUT_SHAPE');
      result.push(descriptor.value as unknown);
    }
    return result;
  }

  function text(value: unknown, limit: number): asserts value is string {
    if (
      typeof value !== 'string' ||
      value.length > limit ||
      !validXmlText(value)
    )
      throw new CompileError('PRINT_INPUT_TEXT');
    textUnits += value.length;
    if (textUnits > 500_000) throw new CompileError('PRINT_INPUT_LIMIT');
  }

  function portable(value: unknown): asserts value is string {
    text(value, 80);
    if (!portableName.test(value)) throw new CompileError('PRINT_MAPPING_KEY');
  }

  function target(value: unknown): asserts value is string {
    text(value, 255);
    if (!apiName.test(value)) throw new CompileError('PRINT_TARGET_NAME');
  }

  function enumeration(
    value: unknown,
    values: readonly string[],
  ): asserts value is string {
    if (typeof value !== 'string' || !values.includes(value))
      throw new CompileError('PRINT_INPUT_ENUM');
    text(value, 255);
  }

  at('mappings');
  const root = record(input, ['schemaVersion', 'mappings']);
  if (root.schemaVersion !== 1) throw new CompileError('PRINT_SCHEMA_VERSION');
  const entries = array(root.mappings, 100);
  const mappings: PrintMapping[] = [];
  const byKey = new Map<string, PrintMapping>();
  for (const [index, value] of entries.entries()) {
    at(`mappings[${index}]`);
    const mapping = record(value, [
      'key',
      'label',
      'order',
      'kind',
      'repeatQuestion',
      'parentMapping',
      'fields',
      ...targetProperties,
    ]);
    portable(mapping.key);
    if (byKey.has(mapping.key))
      throw new CompileError('PRINT_DUPLICATE_MAPPING');
    if (Object.hasOwn(mapping, 'label')) text(mapping.label, 255);
    if (
      typeof mapping.order !== 'number' ||
      !Number.isSafeInteger(mapping.order) ||
      mapping.order <= 0 ||
      mapping.order > 1e12
    )
      throw new CompileError('PRINT_INPUT_NUMBER');
    enumeration(mapping.kind, ['main', 'repeat', 'reference']);
    for (const property of targetProperties) {
      if (property === 'targetObject' || Object.hasOwn(mapping, property))
        target(mapping[property]);
    }
    if (mapping.kind === 'repeat') {
      portable(mapping.repeatQuestion);
      if (
        graph.byName.get(mapping.repeatQuestion)?.definition.type !== 'repeat'
      )
        throw new CompileError('PRINT_REPEAT_QUESTION');
    } else if (Object.hasOwn(mapping, 'repeatQuestion')) {
      throw new CompileError('PRINT_REPEAT_QUESTION');
    }
    if (
      (mapping.kind === 'reference') !==
      Object.hasOwn(mapping, 'matchingField')
    )
      throw new CompileError('PRINT_MATCHING_FIELD');
    if (
      Object.hasOwn(mapping, 'parentMapping') !==
      Object.hasOwn(mapping, 'parentLookupField')
    )
      throw new CompileError('PRINT_PARENT_MAPPING');
    if (Object.hasOwn(mapping, 'parentMapping'))
      portable(mapping.parentMapping);

    const fields = array(mapping.fields, 2000);
    fieldCount += fields.length;
    if (fieldCount > 2000) throw new CompileError('PRINT_INPUT_LIMIT');
    const targets = new Set<string>();
    const decodedFields: PrintFieldMapping[] = [];
    for (const [fieldIndex, fieldValue] of fields.entries()) {
      at(`mappings[${index}].fields[${fieldIndex}]`);
      const field = record(fieldValue, [
        'targetField',
        'transform',
        'sourceKind',
        'question',
        'constantValue',
      ]);
      target(field.targetField);
      const targetKey = field.targetField.toLowerCase();
      if (targets.has(targetKey))
        throw new CompileError('PRINT_DUPLICATE_TARGET');
      targets.add(targetKey);
      if (Object.hasOwn(field, 'transform'))
        enumeration(field.transform, transforms);
      enumeration(field.sourceKind, ['question', 'constant']);
      if (field.sourceKind === 'question') {
        if (Object.hasOwn(field, 'constantValue'))
          throw new CompileError('PRINT_FIELD_SOURCE');
        portable(field.question);
        const question = graph.byName.get(field.question);
        if (!question || !isAnswerable(question.definition.type))
          throw new CompileError('PRINT_FIELD_QUESTION');
      } else {
        if (
          Object.hasOwn(field, 'question') ||
          !Object.hasOwn(field, 'constantValue')
        )
          throw new CompileError('PRINT_FIELD_SOURCE');
        if (field.constantValue !== null) text(field.constantValue, 32768);
      }
      decodedFields.push({ ...field } as PrintFieldMapping);
    }
    const decoded = {
      ...mapping,
      fields: decodedFields,
    } as unknown as PrintMapping;
    mappings.push(decoded);
    byKey.set(decoded.key, decoded);
  }

  for (const [index, mapping] of mappings.entries()) {
    at(`mappings[${index}]`);
    const visited = new Set([mapping.key]);
    let parent = mapping.parentMapping;
    while (parent !== undefined) {
      const parentMapping = byKey.get(parent);
      if (!parentMapping) throw new CompileError('PRINT_PARENT_MAPPING');
      if (visited.has(parent)) throw new CompileError('PRINT_PARENT_CYCLE');
      visited.add(parent);
      parent = parentMapping.parentMapping;
    }
  }
  return { schemaVersion: 1, mappings };
}
