/** Pure validation against a caller-supplied Salesforce Describe snapshot. No I/O. */
import { types } from 'node:util';
import { validXmlText } from '../compiler/definition.js';
import { prepareForm } from '../compiler/prepare.js';
import {
  CompileError,
  type DefinitionGraph,
  type Diagnostic,
  type QuestionType,
} from '../compiler/types.js';
import {
  decodePrintMappings,
  type PrintFieldMapping,
  type PrintTransform,
} from '../print/mappings.js';

const targetFieldTypes = [
  'address',
  'anytype',
  'base64',
  'boolean',
  'combobox',
  'complexvalue',
  'currency',
  'datacategorygroupreference',
  'date',
  'datetime',
  'double',
  'email',
  'encryptedstring',
  'id',
  'integer',
  'json',
  'location',
  'long',
  'multipicklist',
  'percent',
  'phone',
  'picklist',
  'reference',
  'string',
  'textarea',
  'time',
  'url',
] as const;
export type TargetFieldType = (typeof targetFieldTypes)[number];

export interface TargetPicklistValueSchema {
  value: string;
  active: boolean;
}

export interface TargetFieldSchema {
  apiName: string;
  type: TargetFieldType;
  readable: boolean;
  createable: boolean;
  updateable: boolean;
  nillable: boolean;
  externalId: boolean;
  unique: boolean;
  restrictedPicklist: boolean;
  picklistValues: TargetPicklistValueSchema[];
  referenceTo: string[];
}
export interface TargetRecordTypeSchema {
  developerName: string;
  active: boolean;
  available: boolean;
}
export interface TargetObjectSchema {
  apiName: string;
  queryable: boolean;
  createable: boolean;
  updateable: boolean;
  fields: TargetFieldSchema[];
  recordTypes: TargetRecordTypeSchema[];
}
export interface TargetSchemaSnapshot {
  schemaVersion: 1;
  objects: TargetObjectSchema[];
}
export type PublicationTargetResult =
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }
  | {
      readonly ok: true;
      readonly validation: 'target-schema-only';
      readonly warnings: readonly Diagnostic[];
    };

const apiName = /^[A-Za-z][A-Za-z0-9]*(?:_{1,2}[A-Za-z0-9]+)*$/;
const lower = (value: string): string => value.toLowerCase();

function decodeTargetSchema(
  input: unknown,
  at: (path: string) => void,
): TargetSchemaSnapshot {
  let textUnits = 0;
  let fieldCount = 0;
  let picklistValueCount = 0;
  let recordTypeCount = 0;
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
      throw new CompileError('PUBLISH_SCHEMA_SHAPE');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== allowed.length)
      throw new CompileError('PUBLISH_SCHEMA_SHAPE');
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (
        typeof key !== 'string' ||
        !allowed.includes(key) ||
        !Object.hasOwn(descriptors[key]!, 'value')
      )
        throw new CompileError('PUBLISH_SCHEMA_SHAPE');
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
      throw new CompileError('PUBLISH_SCHEMA_SHAPE');
    if (value.length > limit) throw new CompileError('PUBLISH_SCHEMA_LIMIT');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== value.length + 1)
      throw new CompileError('PUBLISH_SCHEMA_SHAPE');
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, 'value'))
        throw new CompileError('PUBLISH_SCHEMA_SHAPE');
      result.push(descriptor.value as unknown);
    }
    return result;
  }
  function name(value: unknown): asserts value is string {
    if (
      typeof value !== 'string' ||
      value.length > 255 ||
      !validXmlText(value) ||
      !apiName.test(value)
    )
      throw new CompileError('PUBLISH_SCHEMA_NAME');
    textUnits += value.length;
    if (textUnits > 500_000) throw new CompileError('PUBLISH_SCHEMA_LIMIT');
  }
  function bool(value: unknown): asserts value is boolean {
    if (typeof value !== 'boolean')
      throw new CompileError('PUBLISH_SCHEMA_SHAPE');
  }
  function enumeration<T extends string>(
    value: unknown,
    values: readonly T[],
  ): asserts value is T {
    if (typeof value !== 'string' || !values.includes(value as T))
      throw new CompileError('PUBLISH_SCHEMA_SHAPE');
    text(value, 255);
  }
  function text(value: unknown, limit: number): asserts value is string {
    if (
      typeof value !== 'string' ||
      value.length > limit ||
      !validXmlText(value)
    )
      throw new CompileError('PUBLISH_SCHEMA_TEXT');
    textUnits += value.length;
    if (textUnits > 500_000) throw new CompileError('PUBLISH_SCHEMA_LIMIT');
  }

  at('targetSchema');
  const root = record(input, ['schemaVersion', 'objects']);
  if (root.schemaVersion !== 1)
    throw new CompileError('PUBLISH_SCHEMA_VERSION');
  const objects: TargetObjectSchema[] = [];
  const objectNames = new Set<string>();
  for (const [objectIndex, objectValue] of array(root.objects, 100).entries()) {
    at(`targetSchema.objects[${objectIndex}]`);
    const object = record(objectValue, [
      'apiName',
      'queryable',
      'createable',
      'updateable',
      'fields',
      'recordTypes',
    ]);
    name(object.apiName);
    bool(object.queryable);
    bool(object.createable);
    bool(object.updateable);
    if (objectNames.has(lower(object.apiName)))
      throw new CompileError('PUBLISH_SCHEMA_DUPLICATE');
    objectNames.add(lower(object.apiName));
    const fields: TargetFieldSchema[] = [];
    const fieldNames = new Set<string>();
    const fieldValues = array(object.fields, 2000);
    fieldCount += fieldValues.length;
    if (fieldCount > 5000) throw new CompileError('PUBLISH_SCHEMA_LIMIT');
    for (const [fieldIndex, fieldValue] of fieldValues.entries()) {
      at(`targetSchema.objects[${objectIndex}].fields[${fieldIndex}]`);
      const field = record(fieldValue, [
        'apiName',
        'type',
        'readable',
        'createable',
        'updateable',
        'nillable',
        'externalId',
        'unique',
        'restrictedPicklist',
        'picklistValues',
        'referenceTo',
      ]);
      name(field.apiName);
      enumeration(field.type, targetFieldTypes);
      for (const property of [
        'readable',
        'createable',
        'updateable',
        'nillable',
        'externalId',
        'unique',
        'restrictedPicklist',
      ] as const)
        bool(field[property]);
      if (fieldNames.has(lower(field.apiName)))
        throw new CompileError('PUBLISH_SCHEMA_DUPLICATE');
      fieldNames.add(lower(field.apiName));
      const referenceTo = array(field.referenceTo, 100);
      const targets = new Set<string>();
      for (const target of referenceTo) {
        name(target);
        if (targets.has(lower(target)))
          throw new CompileError('PUBLISH_SCHEMA_DUPLICATE');
        targets.add(lower(target));
      }
      const picklistValues: TargetPicklistValueSchema[] = [];
      const picklistValueNames = new Set<string>();
      const picklistValueInput = array(field.picklistValues, 2000);
      picklistValueCount += picklistValueInput.length;
      if (picklistValueCount > 10_000)
        throw new CompileError('PUBLISH_SCHEMA_LIMIT');
      for (const picklistValue of picklistValueInput) {
        const entry = record(picklistValue, ['value', 'active']);
        text(entry.value, 255);
        bool(entry.active);
        if (picklistValueNames.has(entry.value))
          throw new CompileError('PUBLISH_SCHEMA_DUPLICATE');
        picklistValueNames.add(entry.value);
        picklistValues.push({
          value: entry.value,
          active: entry.active,
        });
      }
      const isPicklist =
        field.type === 'picklist' ||
        field.type === 'multipicklist' ||
        field.type === 'combobox';
      if (
        (!isPicklist &&
          (field.restrictedPicklist || picklistValues.length > 0)) ||
        (field.type !== 'reference' && referenceTo.length > 0)
      )
        throw new CompileError('PUBLISH_SCHEMA_SHAPE');
      fields.push({
        apiName: field.apiName,
        type: field.type,
        readable: field.readable as boolean,
        createable: field.createable as boolean,
        updateable: field.updateable as boolean,
        nillable: field.nillable as boolean,
        externalId: field.externalId as boolean,
        unique: field.unique as boolean,
        restrictedPicklist: field.restrictedPicklist as boolean,
        picklistValues,
        referenceTo: [...referenceTo] as string[],
      });
    }
    const recordTypes: TargetRecordTypeSchema[] = [];
    const recordTypeNames = new Set<string>();
    const recordTypeValues = array(object.recordTypes, 200);
    recordTypeCount += recordTypeValues.length;
    if (recordTypeCount > 1000) throw new CompileError('PUBLISH_SCHEMA_LIMIT');
    for (const [
      recordTypeIndex,
      recordTypeValue,
    ] of recordTypeValues.entries()) {
      at(
        `targetSchema.objects[${objectIndex}].recordTypes[${recordTypeIndex}]`,
      );
      const recordType = record(recordTypeValue, [
        'developerName',
        'active',
        'available',
      ]);
      name(recordType.developerName);
      bool(recordType.active);
      bool(recordType.available);
      if (recordTypeNames.has(lower(recordType.developerName)))
        throw new CompileError('PUBLISH_SCHEMA_DUPLICATE');
      recordTypeNames.add(lower(recordType.developerName));
      recordTypes.push({
        developerName: recordType.developerName,
        active: recordType.active,
        available: recordType.available,
      });
    }
    objects.push({
      apiName: object.apiName,
      queryable: object.queryable,
      createable: object.createable,
      updateable: object.updateable,
      fields,
      recordTypes,
    });
  }
  return { schemaVersion: 1, objects };
}

const textTargets = new Set<TargetFieldType>([
  'email',
  'encryptedstring',
  'phone',
  'string',
  'textarea',
  'url',
]);
const numericTargets = new Set<TargetFieldType>([
  'currency',
  'double',
  'integer',
  'long',
  'percent',
]);
const mediaQuestions = new Set<QuestionType>([
  'photo',
  'signature',
  'audio',
  'video',
  'file',
]);
const plainTextQuestions = new Set<QuestionType>([
  'text',
  'text_long',
  'barcode',
  'reference',
]);

function sourceSupportsTransform(
  assignment: PrintFieldMapping,
  questionType: QuestionType | undefined,
  transform: PrintTransform,
): boolean {
  if (assignment.sourceKind === 'constant')
    return ![
      'multi_select_join',
      'geopoint_lat',
      'geopoint_lng',
      'geopoint_accuracy',
      'file_url',
    ].includes(transform);
  if (questionType === undefined) return false;
  switch (transform) {
    case 'none':
      return true;
    case 'picklist_match':
      return questionType === 'select_one';
    case 'multi_select_join':
      return questionType === 'select_multiple';
    case 'lookup_by_external_id':
      return (
        plainTextQuestions.has(questionType) || questionType === 'select_one'
      );
    case 'date_only':
      return questionType === 'date' || questionType === 'datetime';
    case 'boolean_yes_no':
      return (
        plainTextQuestions.has(questionType) || questionType === 'select_one'
      );
    case 'number':
      return (
        plainTextQuestions.has(questionType) ||
        questionType === 'integer' ||
        questionType === 'decimal' ||
        questionType === 'calculate'
      );
    case 'text_truncate':
      return true;
    case 'geopoint_lat':
    case 'geopoint_lng':
    case 'geopoint_accuracy':
      return questionType === 'geopoint';
    case 'file_url':
      return mediaQuestions.has(questionType);
  }
}

function targetSupportsTransform(
  type: TargetFieldType,
  transform: PrintTransform,
  questionType: QuestionType | undefined,
  constant: boolean,
): boolean {
  switch (transform) {
    case 'picklist_match':
      return type === 'picklist' || type === 'combobox';
    case 'multi_select_join':
      return type === 'multipicklist' || textTargets.has(type);
    case 'lookup_by_external_id':
      return type === 'reference';
    case 'date_only':
      return type === 'date';
    case 'boolean_yes_no':
      return type === 'boolean';
    case 'number':
    case 'geopoint_lat':
    case 'geopoint_lng':
    case 'geopoint_accuracy':
      return numericTargets.has(type);
    case 'text_truncate':
    case 'file_url':
      return textTargets.has(type);
    case 'none':
      if (constant)
        return (
          textTargets.has(type) || type === 'picklist' || type === 'combobox'
        );
      if (questionType === undefined) return false;
      if (plainTextQuestions.has(questionType))
        return (
          textTargets.has(type) || type === 'picklist' || type === 'combobox'
        );
      if (questionType === 'integer') return numericTargets.has(type);
      if (questionType === 'decimal')
        return type === 'currency' || type === 'double' || type === 'percent';
      if (questionType === 'select_one')
        return (
          textTargets.has(type) || type === 'picklist' || type === 'combobox'
        );
      if (questionType === 'select_multiple') return textTargets.has(type);
      if (questionType === 'date') return type === 'date';
      if (questionType === 'time') return type === 'time';
      if (questionType === 'datetime') return type === 'datetime';
      if (
        questionType === 'geopoint' ||
        questionType === 'geotrace' ||
        questionType === 'geoshape'
      )
        return textTargets.has(type);
      return false;
  }
}

function picklistSourceValues(
  assignment: PrintFieldMapping,
  questionType: QuestionType | undefined,
  graph: DefinitionGraph,
): readonly string[] | undefined {
  if (assignment.sourceKind === 'constant')
    return assignment.constantValue === null
      ? ['']
      : [assignment.constantValue];
  if (questionType !== 'select_one' && questionType !== 'select_multiple')
    return undefined;
  const question = graph.byName.get(assignment.question)?.definition;
  const list = question?.choiceList
    ? graph.lists.get(question.choiceList)
    : undefined;
  return list?.choices.map((choice) => choice.value);
}

/** Validate mappings using a fresh integration-user snapshot supplied by the caller. */
export function validatePublicationTargets(
  formInput: unknown,
  mappingInput: unknown,
  schemaInput: unknown,
): PublicationTargetResult {
  const prepared = prepareForm(formInput);
  if (!prepared.ok) return prepared;
  let location = 'mappings';
  const at = (path: string): void => {
    location = path;
  };
  try {
    const bundle = decodePrintMappings(mappingInput, prepared.graph, at);
    const schema = decodeTargetSchema(schemaInput, at);
    const diagnostics: Diagnostic[] = [];
    const diagnosticKeys = new Set<string>();
    const warnings: Diagnostic[] = [...prepared.warnings];
    const objects = new Map(
      schema.objects.map((object) => [lower(object.apiName), object]),
    );
    const mappings = new Map(
      bundle.mappings.map((mapping) => [mapping.key, mapping]),
    );
    const issue = (code: string, path: string): void => {
      const key = `${code}\0${path}`;
      if (diagnosticKeys.has(key)) return;
      diagnosticKeys.add(key);
      diagnostics.push({ code, location: path });
    };
    for (const [mappingIndex, mapping] of bundle.mappings.entries()) {
      const base = `mappings[${mappingIndex}]`;
      const object = objects.get(lower(mapping.targetObject));
      if (!object) {
        issue('PUBLISH_TARGET_OBJECT', `${base}.targetObject`);
        continue;
      }
      const writesReference =
        mapping.kind === 'reference' &&
        (mapping.upsertExternalIdField !== undefined ||
          mapping.fields.length > 0 ||
          mapping.collectorField !== undefined ||
          mapping.submissionField !== undefined);
      if (
        (mapping.kind === 'reference' && !object.queryable) ||
        (mapping.kind !== 'reference' && !object.createable) ||
        (writesReference && (!object.createable || !object.updateable))
      )
        issue('PUBLISH_TARGET_OBJECT_ACCESS', `${base}.targetObject`);
      const fields = new Map(
        object.fields.map((field) => [lower(field.apiName), field]),
      );
      const resolveField = (
        api: string | undefined,
        path: string,
      ): TargetFieldSchema | undefined => {
        if (api === undefined) return undefined;
        const field = fields.get(lower(api));
        if (!field) issue('PUBLISH_TARGET_FIELD', path);
        return field;
      };
      const canWrite = (field: TargetFieldSchema): boolean =>
        field.createable && (!writesReference || field.updateable);
      if (mapping.recordType !== undefined) {
        const recordType = object.recordTypes.find(
          (entry) => lower(entry.developerName) === lower(mapping.recordType!),
        );
        if (!recordType || !recordType.active || !recordType.available)
          issue('PUBLISH_RECORD_TYPE', `${base}.recordType`);
      }
      for (const [fieldIndex, assignment] of mapping.fields.entries()) {
        const path = `${base}.fields[${fieldIndex}].targetField`;
        const field = resolveField(assignment.targetField, path);
        if (field && !canWrite(field))
          issue('PUBLISH_TARGET_FIELD_WRITE', path);
        if (field) {
          const transform = assignment.transform ?? 'none';
          const questionType =
            assignment.sourceKind === 'question'
              ? prepared.graph.byName.get(assignment.question)?.definition.type
              : undefined;
          const blankConstant =
            assignment.sourceKind === 'constant' &&
            (assignment.constantValue === null ||
              assignment.constantValue.trim().length === 0);
          if (
            (blankConstant && transform !== 'none') ||
            (!blankConstant &&
              (!sourceSupportsTransform(assignment, questionType, transform) ||
                !targetSupportsTransform(
                  field.type,
                  transform,
                  questionType,
                  assignment.sourceKind === 'constant',
                )))
          ) {
            issue('PUBLISH_TARGET_FIELD_TYPE', path);
          } else if (blankConstant && !field.nillable) {
            issue('PUBLISH_TARGET_FIELD_REQUIRED', path);
          } else if (
            !blankConstant &&
            field.restrictedPicklist &&
            (field.type === 'picklist' ||
              field.type === 'multipicklist' ||
              field.type === 'combobox')
          ) {
            const supplied = picklistSourceValues(
              assignment,
              questionType,
              prepared.graph,
            );
            const active = new Set(
              field.picklistValues
                .filter((value) => value.active)
                .map((value) => value.value),
            );
            if (
              supplied === undefined ||
              supplied.some((value) => !active.has(value))
            )
              issue('PUBLISH_PICKLIST_VALUE', path);
          }
        }
      }
      for (const property of ['collectorField', 'submissionField'] as const) {
        const value = mapping[property];
        const path = `${base}.${property}`;
        const field = resolveField(value, path);
        if (field && !canWrite(field))
          issue('PUBLISH_TARGET_FIELD_WRITE', path);
        if (
          value !== undefined &&
          mapping.fields.some(
            (assignment) => lower(assignment.targetField) === lower(value),
          )
        )
          issue('PUBLISH_STAMP_CONFLICT', path);
      }
      if (
        mapping.collectorField !== undefined &&
        mapping.submissionField !== undefined &&
        lower(mapping.collectorField) === lower(mapping.submissionField)
      )
        issue('PUBLISH_STAMP_CONFLICT', `${base}.submissionField`);
      const matching = resolveField(
        mapping.matchingField,
        `${base}.matchingField`,
      );
      if (matching && !matching.readable)
        issue('PUBLISH_TARGET_FIELD_READ', `${base}.matchingField`);
      if (matching && !matching.unique)
        warnings.push({
          code: 'PUBLISH_MATCH_NOT_UNIQUE',
          location: `${base}.matchingField`,
        });
      const external = resolveField(
        mapping.upsertExternalIdField,
        `${base}.upsertExternalIdField`,
      );
      if (
        external &&
        (!external.readable ||
          !external.createable ||
          !external.updateable ||
          !external.externalId ||
          !external.unique)
      )
        issue('PUBLISH_EXTERNAL_ID', `${base}.upsertExternalIdField`);
      const parentLookup = resolveField(
        mapping.parentLookupField,
        `${base}.parentLookupField`,
      );
      if (parentLookup) {
        if (!canWrite(parentLookup))
          issue('PUBLISH_TARGET_FIELD_WRITE', `${base}.parentLookupField`);
        const parent = mappings.get(mapping.parentMapping!);
        if (
          parent &&
          !parentLookup.referenceTo.some(
            (target) => lower(target) === lower(parent.targetObject),
          )
        )
          issue('PUBLISH_PARENT_LOOKUP', `${base}.parentLookupField`);
      }
    }
    return diagnostics.length
      ? { ok: false, diagnostics }
      : { ok: true, validation: 'target-schema-only', warnings };
  } catch (error) {
    if (error instanceof CompileError)
      return { ok: false, diagnostics: [{ code: error.code, location }] };
    throw error;
  }
}
