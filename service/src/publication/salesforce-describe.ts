/** Fresh Salesforce REST Describe normalization only. No auth, cache, or publication. */
import { types } from 'node:util';
import { validXmlText } from '../compiler/definition.js';
import type { Diagnostic } from '../compiler/types.js';
import {
  isTargetFieldType,
  type TargetFieldSchema,
  type TargetFieldType,
  type TargetObjectSchema,
  type TargetPicklistValueSchema,
  type TargetRecordTypeSchema,
  type TargetSchemaSnapshot,
} from './target-schema.js';

const apiName = /^[A-Za-z][A-Za-z0-9]*(?:_{1,2}[A-Za-z0-9]+)*$/;
const lower = (value: string): string => value.toLowerCase();
const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
const compareName = (a: string, b: string): number =>
  compareText(lower(a), lower(b)) || compareText(a, b);

interface DescribeBudget {
  fields: number;
  picklistValues: number;
  recordTypes: number;
  textUnits: number;
}

export type DescribeObject = (apiName: string) => Promise<unknown>;

export type SalesforceDescribeResult =
  | {
      readonly ok: true;
      readonly snapshot: TargetSchemaSnapshot;
      readonly requestCount: number;
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly Diagnostic[];
      readonly requestCount: number;
    };

class DescribeFailure extends Error {
  constructor(
    readonly code: string,
    readonly location: string,
  ) {
    super(code);
    this.name = 'DescribeFailure';
  }
}

function fail(code: string, location: string): never {
  throw new DescribeFailure(code, location);
}

function record(
  value: unknown,
  location: string,
  propertyLimit: number,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    fail('PUBLISH_DESCRIBE_SHAPE', location);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > propertyLimit) fail('PUBLISH_DESCRIBE_LIMIT', location);
  const detached = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'))
      fail('PUBLISH_DESCRIBE_SHAPE', location);
    detached[key] = descriptors[key]!.value as unknown;
  }
  return detached;
}

function required(
  value: Record<string, unknown>,
  key: string,
  location: string,
): unknown {
  if (!Object.hasOwn(value, key))
    fail('PUBLISH_DESCRIBE_SHAPE', `${location}.${key}`);
  return value[key];
}

function array(value: unknown, location: string, limit: number): unknown[] {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > limit
  )
    fail(
      Array.isArray(value) && value.length > limit
        ? 'PUBLISH_DESCRIBE_LIMIT'
        : 'PUBLISH_DESCRIBE_SHAPE',
      location,
    );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1)
    fail('PUBLISH_DESCRIBE_SHAPE', location);
  const detached: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value'))
      fail('PUBLISH_DESCRIBE_SHAPE', `${location}[${index}]`);
    detached.push(descriptor.value as unknown);
  }
  return detached;
}

function countText(
  value: string,
  location: string,
  budget?: DescribeBudget,
): string {
  if (budget) {
    budget.textUnits += value.length;
    if (budget.textUnits > 500_000) fail('PUBLISH_DESCRIBE_LIMIT', location);
  }
  return value;
}

function name(
  value: unknown,
  location: string,
  budget?: DescribeBudget,
): string {
  if (
    typeof value !== 'string' ||
    value.length > 255 ||
    !validXmlText(value) ||
    !apiName.test(value)
  )
    fail('PUBLISH_DESCRIBE_SHAPE', location);
  return countText(value, location, budget);
}

function text(value: unknown, location: string): string {
  if (typeof value !== 'string' || value.length > 32768 || !validXmlText(value))
    fail('PUBLISH_DESCRIBE_SHAPE', location);
  return value;
}

function bool(value: unknown, location: string): boolean {
  if (typeof value !== 'boolean') fail('PUBLISH_DESCRIBE_SHAPE', location);
  return value;
}

function fieldType(
  value: unknown,
  location: string,
  budget: DescribeBudget,
): TargetFieldType {
  if (typeof value !== 'string') fail('PUBLISH_DESCRIBE_TYPE', location);
  const folded = lower(value);
  const canonical = folded === 'int' ? 'integer' : folded;
  if (!isTargetFieldType(canonical)) fail('PUBLISH_DESCRIBE_TYPE', location);
  countText(canonical, location, budget);
  return canonical;
}

function normalizePicklistValues(
  value: unknown,
  location: string,
  budget: DescribeBudget,
): TargetPicklistValueSchema[] {
  const entries = array(value, location, 2000);
  const collapsed = new Map<
    string,
    TargetPicklistValueSchema & { location: string }
  >();
  for (const [index, entry] of entries.entries()) {
    const path = `${location}[${index}]`;
    const raw = record(entry, path, 32);
    const picklistValue = text(required(raw, 'value', path), `${path}.value`);
    const active = bool(required(raw, 'active', path), `${path}.active`);
    const existing = collapsed.get(picklistValue);
    if (existing) existing.active ||= active;
    else
      collapsed.set(picklistValue, {
        value: picklistValue,
        active,
        location: `${path}.value`,
      });
  }
  budget.picklistValues += collapsed.size;
  if (budget.picklistValues > 10_000) fail('PUBLISH_DESCRIBE_LIMIT', location);
  const normalized = [...collapsed.values()].map(
    ({ value: picklistValue, active, location: valueLocation }) => ({
      value: countText(picklistValue, valueLocation, budget),
      active,
    }),
  );
  return normalized.sort((a, b) => compareText(a.value, b.value));
}

function normalizeField(
  value: unknown,
  location: string,
  budget: DescribeBudget,
): TargetFieldSchema {
  const raw = record(value, location, 128);
  const type = fieldType(
    required(raw, 'type', location),
    `${location}.type`,
    budget,
  );
  const references = array(
    required(raw, 'referenceTo', location),
    `${location}.referenceTo`,
    100,
  ).map((entry, index) =>
    name(entry, `${location}.referenceTo[${index}]`, budget),
  );
  const uniqueReferences = new Set(references.map(lower));
  if (uniqueReferences.size !== references.length)
    fail('PUBLISH_DESCRIBE_SHAPE', `${location}.referenceTo`);
  const picklistValues = normalizePicklistValues(
    required(raw, 'picklistValues', location),
    `${location}.picklistValues`,
    budget,
  );
  const restrictedPicklist = bool(
    required(raw, 'restrictedPicklist', location),
    `${location}.restrictedPicklist`,
  );
  const picklistType =
    type === 'picklist' || type === 'multipicklist' || type === 'combobox';
  if (
    (!picklistType && (restrictedPicklist || picklistValues.length > 0)) ||
    (type !== 'reference' && references.length > 0)
  )
    fail('PUBLISH_DESCRIBE_SHAPE', location);
  return {
    apiName: name(required(raw, 'name', location), `${location}.name`, budget),
    type,
    readable: true,
    createable: bool(
      required(raw, 'createable', location),
      `${location}.createable`,
    ),
    updateable: bool(
      required(raw, 'updateable', location),
      `${location}.updateable`,
    ),
    nillable: bool(required(raw, 'nillable', location), `${location}.nillable`),
    externalId: bool(
      required(raw, 'externalId', location),
      `${location}.externalId`,
    ),
    unique: bool(required(raw, 'unique', location), `${location}.unique`),
    restrictedPicklist,
    picklistValues,
    referenceTo: references.sort(compareName),
  };
}

function normalizeRecordType(
  value: unknown,
  location: string,
  budget: DescribeBudget,
): TargetRecordTypeSchema {
  const raw = record(value, location, 32);
  return {
    developerName: name(
      required(raw, 'developerName', location),
      `${location}.developerName`,
      budget,
    ),
    active: bool(required(raw, 'active', location), `${location}.active`),
    available: bool(
      required(raw, 'available', location),
      `${location}.available`,
    ),
  };
}

function normalizeObject(
  value: unknown,
  requestedName: string,
  location: string,
  budget: DescribeBudget,
): TargetObjectSchema {
  const raw = record(value, location, 256);
  const objectName = name(
    required(raw, 'name', location),
    `${location}.name`,
    budget,
  );
  if (lower(objectName) !== lower(requestedName))
    fail('PUBLISH_DESCRIBE_IDENTITY', `${location}.name`);
  const fieldEntries = array(
    required(raw, 'fields', location),
    `${location}.fields`,
    5000,
  );
  budget.fields += fieldEntries.length;
  if (budget.fields > 5000)
    fail('PUBLISH_DESCRIBE_LIMIT', `${location}.fields`);
  const fields = fieldEntries.map((field, index) =>
    normalizeField(field, `${location}.fields[${index}]`, budget),
  );
  const fieldNames = new Set(fields.map((field) => lower(field.apiName)));
  if (fieldNames.size !== fields.length)
    fail('PUBLISH_DESCRIBE_SHAPE', `${location}.fields`);
  const recordTypeEntries = array(
    required(raw, 'recordTypeInfos', location),
    `${location}.recordTypeInfos`,
    1000,
  );
  budget.recordTypes += recordTypeEntries.length;
  if (budget.recordTypes > 1000)
    fail('PUBLISH_DESCRIBE_LIMIT', `${location}.recordTypeInfos`);
  const recordTypes = recordTypeEntries.map((recordType, index) =>
    normalizeRecordType(
      recordType,
      `${location}.recordTypeInfos[${index}]`,
      budget,
    ),
  );
  const recordTypeNames = new Set(
    recordTypes.map((recordType) => lower(recordType.developerName)),
  );
  if (recordTypeNames.size !== recordTypes.length)
    fail('PUBLISH_DESCRIBE_SHAPE', `${location}.recordTypeInfos`);
  return {
    apiName: objectName,
    queryable: bool(
      required(raw, 'queryable', location),
      `${location}.queryable`,
    ),
    createable: bool(
      required(raw, 'createable', location),
      `${location}.createable`,
    ),
    updateable: bool(
      required(raw, 'updateable', location),
      `${location}.updateable`,
    ),
    fields: fields.sort((a, b) => compareName(a.apiName, b.apiName)),
    recordTypes: recordTypes.sort((a, b) =>
      compareName(a.developerName, b.developerName),
    ),
  };
}

/**
 * Load one uncached REST Describe per distinct object name. The supplied client
 * must already be bound to the tenant integration-user session.
 */
export async function loadSalesforceTargetSchema(
  objectNamesInput: unknown,
  describeObject: DescribeObject,
): Promise<SalesforceDescribeResult> {
  let objectNames: string[];
  try {
    objectNames = array(objectNamesInput, 'objects', 100).map((value, index) =>
      name(value, `objects[${index}]`),
    );
  } catch (error) {
    if (error instanceof DescribeFailure)
      return {
        ok: false,
        diagnostics: [{ code: error.code, location: error.location }],
        requestCount: 0,
      };
    throw error;
  }
  const distinct = new Map<string, string>();
  for (const objectName of objectNames)
    if (!distinct.has(lower(objectName)))
      distinct.set(lower(objectName), objectName);
  const requested = [...distinct.values()].sort(compareName);
  const objects: TargetObjectSchema[] = [];
  let requestCount = 0;
  const budget: DescribeBudget = {
    fields: 0,
    picklistValues: 0,
    recordTypes: 0,
    textUnits: 0,
  };
  for (const [index, objectName] of requested.entries()) {
    let response: unknown;
    try {
      requestCount++;
      response = await describeObject(objectName);
    } catch {
      return {
        ok: false,
        diagnostics: [
          { code: 'PUBLISH_DESCRIBE_REQUEST', location: `objects[${index}]` },
        ],
        requestCount,
      };
    }
    try {
      objects.push(
        normalizeObject(response, objectName, `objects[${index}]`, budget),
      );
    } catch (error) {
      if (error instanceof DescribeFailure)
        return {
          ok: false,
          diagnostics: [{ code: error.code, location: error.location }],
          requestCount,
        };
      throw error;
    }
  }
  return {
    ok: true,
    snapshot: { schemaVersion: 1, objects },
    requestCount,
  };
}
