/** Bounded publication preflight only. No auth, persistence, or publication. */
import { createHash } from 'node:crypto';
import { compileForm } from '../compiler/compile.js';
import { prepareForm } from '../compiler/prepare.js';
import { CompileError, type Diagnostic } from '../compiler/types.js';
import {
  decodePrintMappings,
  type PrintMappingBundle,
} from '../print/mappings.js';
import {
  loadSalesforceTargetSchema,
  type DescribeObject,
} from './salesforce-describe.js';
import {
  validatePublicationTargets,
  type TargetSchemaSnapshot,
} from './target-schema.js';

const lower = (value: string): string => value.toLowerCase();
const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
const compareName = (a: string, b: string): number =>
  compareText(lower(a), lower(b)) || compareText(a, b);

export type PublicationPreflightResult =
  | {
      readonly ok: false;
      readonly diagnostics: readonly Diagnostic[];
      readonly requestCount: number;
    }
  | {
      readonly ok: true;
      readonly validation: 'publication-preflight-only';
      readonly xml: string;
      readonly xformSha256: string;
      readonly targetObjects: readonly string[];
      readonly requestCount: number;
      readonly warnings: readonly Diagnostic[];
    };

type RejectedPreflightResult = Extract<
  PublicationPreflightResult,
  { readonly ok: false }
>;

/** Internal composition result for the package builder; not a publish verdict. */
export type PublicationPreflightDetailsResult =
  | RejectedPreflightResult
  | (Extract<PublicationPreflightResult, { readonly ok: true }> & {
      readonly targetSchema: TargetSchemaSnapshot;
    });

function immutableDiagnostics(
  diagnostics: readonly Diagnostic[],
): readonly Diagnostic[] {
  return Object.freeze(
    diagnostics.map(({ code, location }) => Object.freeze({ code, location })),
  );
}

function immutableSnapshot(
  snapshot: TargetSchemaSnapshot,
): TargetSchemaSnapshot {
  for (const object of snapshot.objects) {
    for (const field of object.fields) {
      for (const value of field.picklistValues) Object.freeze(value);
      Object.freeze(field.picklistValues);
      Object.freeze(field.referenceTo);
      Object.freeze(field);
    }
    for (const recordType of object.recordTypes) Object.freeze(recordType);
    Object.freeze(object.fields);
    Object.freeze(object.recordTypes);
    Object.freeze(object);
  }
  Object.freeze(snapshot.objects);
  return Object.freeze(snapshot);
}

function rejected(
  diagnostics: readonly Diagnostic[],
  requestCount: number,
): RejectedPreflightResult {
  return Object.freeze({
    ok: false,
    diagnostics: immutableDiagnostics(diagnostics),
    requestCount,
  });
}

function targetObjects(bundle: PrintMappingBundle): readonly string[] {
  const distinct = new Map<string, string>();
  for (const mapping of bundle.mappings) {
    const key = lower(mapping.targetObject);
    const existing = distinct.get(key);
    if (
      existing === undefined ||
      compareText(mapping.targetObject, existing) < 0
    )
      distinct.set(key, mapping.targetObject);
  }
  return Object.freeze([...distinct.values()].sort(compareName));
}

/**
 * Compile and validate a detached definition/mapping snapshot against Describe
 * metadata loaded immediately by the injected integration-user client.
 */
export async function preflightPublicationDetails(
  formInput: unknown,
  mappingInput: unknown,
  describeObject: DescribeObject,
): Promise<PublicationPreflightDetailsResult> {
  const prepared = prepareForm(formInput);
  if (!prepared.ok) return rejected(prepared.diagnostics, 0);

  let location = 'mappings';
  const at = (path: string): void => {
    location = path;
  };
  let decodedMappings: PrintMappingBundle;
  try {
    decodedMappings = decodePrintMappings(mappingInput, prepared.graph, at);
  } catch (error) {
    if (error instanceof CompileError)
      return rejected([{ code: error.code, location }], 0);
    throw error;
  }

  // Use decoder-owned snapshots after this point. Caller mutation while Describe
  // is in flight cannot change the XForm or the mappings that are validated.
  const definition = structuredClone(prepared.graph.definition);
  const mappings = structuredClone(decodedMappings);
  const compiled = compileForm(definition);
  if (!compiled.ok) return rejected(compiled.diagnostics, 0);
  const objects = targetObjects(mappings);
  const described = await loadSalesforceTargetSchema(objects, describeObject);
  if (!described.ok)
    return rejected(described.diagnostics, described.requestCount);
  const validated = validatePublicationTargets(
    definition,
    mappings,
    described.snapshot,
  );
  if (!validated.ok)
    return rejected(validated.diagnostics, described.requestCount);

  return Object.freeze({
    ok: true,
    validation: 'publication-preflight-only',
    xml: compiled.xml,
    xformSha256: createHash('sha256').update(compiled.xml).digest('hex'),
    targetObjects: objects,
    requestCount: described.requestCount,
    warnings: immutableDiagnostics(validated.warnings),
    targetSchema: immutableSnapshot(described.snapshot),
  });
}

/** Preserve ADR 0022's deliberately minimal public preflight result. */
export async function preflightPublication(
  formInput: unknown,
  mappingInput: unknown,
  describeObject: DescribeObject,
): Promise<PublicationPreflightResult> {
  const result = await preflightPublicationDetails(
    formInput,
    mappingInput,
    describeObject,
  );
  if (!result.ok) return result;
  return Object.freeze({
    ok: true,
    validation: result.validation,
    xml: result.xml,
    xformSha256: result.xformSha256,
    targetObjects: result.targetObjects,
    requestCount: result.requestCount,
    warnings: result.warnings,
  });
}
