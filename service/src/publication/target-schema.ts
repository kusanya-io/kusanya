/** Pure validation against a caller-supplied Salesforce Describe snapshot. No I/O. */
import { types } from 'node:util';
import { validXmlText } from '../compiler/definition.js';
import { prepareForm } from '../compiler/prepare.js';
import { CompileError, type Diagnostic } from '../compiler/types.js';
import { decodePrintMappings } from '../print/mappings.js';

export interface TargetFieldSchema {
  apiName: string;
  readable: boolean;
  createable: boolean;
  updateable: boolean;
  externalId: boolean;
  unique: boolean;
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
        'readable',
        'createable',
        'updateable',
        'externalId',
        'unique',
        'referenceTo',
      ]);
      name(field.apiName);
      for (const property of [
        'readable',
        'createable',
        'updateable',
        'externalId',
        'unique',
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
      fields.push({
        apiName: field.apiName,
        readable: field.readable as boolean,
        createable: field.createable as boolean,
        updateable: field.updateable as boolean,
        externalId: field.externalId as boolean,
        unique: field.unique as boolean,
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
