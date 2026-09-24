/** Content-addressed publication package only. No storage or publication I/O. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import type { Diagnostic } from '../compiler/types.js';
import { exportAuthoringBundle } from '../interchange/bundle.js';
import { exportXlsFormWorkbook } from '../interchange/xlsx-workbook.js';
import type { DescribeObject } from './salesforce-describe.js';
import type { ValidateXForm } from './odk-validate.js';
import { preflightPublicationDetails } from './preflight.js';
import { dynamicRepeatCardinalityPolicy } from '../submission/repeat-cardinality.js';

const maxTargetSchemaJson = 8_000_000;
const maxPackageJson = 8_000_000;
const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
const validatorFailures = new Map([
  ['PUBLICATION_XFORM_INVALID', 'xform'],
  ['PUBLICATION_VALIDATOR_CONFIGURATION', 'validator'],
  ['PUBLICATION_VALIDATOR_PIN', 'validator'],
  ['PUBLICATION_VALIDATOR_FAILURE', 'validator'],
  ['PUBLICATION_VALIDATOR_CLEANUP', 'validator'],
]);

export type PublicationPackageResult =
  | {
      readonly ok: false;
      readonly diagnostics: readonly Diagnostic[];
      readonly requestCount: number;
    }
  | {
      readonly ok: true;
      readonly validation: 'odk-validate-1.20.0';
      readonly audience: 'publisher-only';
      readonly packageJson: string;
      readonly packageSha256: string;
      readonly authoringSha256: string;
      readonly xformSha256: string;
      readonly xlsformSha256: string;
      readonly targetSchemaSha256: string;
      readonly targetObjects: readonly string[];
      readonly requestCount: number;
      readonly warnings: readonly Diagnostic[];
    };

function immutableDiagnostics(
  diagnostics: readonly Diagnostic[],
): readonly Diagnostic[] {
  return Object.freeze(
    diagnostics.map(({ code, location }) => Object.freeze({ code, location })),
  );
}

function rejected(
  diagnostics: readonly Diagnostic[],
  requestCount: number,
): PublicationPackageResult {
  return Object.freeze({
    ok: false,
    diagnostics: immutableDiagnostics(diagnostics),
    requestCount,
  });
}

function decodeValidationResult(value: unknown): true | Diagnostic {
  if (value === null || typeof value !== 'object' || types.isProxy(value))
    throw new PackageFailure('PUBLICATION_VALIDATOR_FAILURE');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getPrototypeOf(value) !== Object.prototype)
    throw new PackageFailure('PUBLICATION_VALIDATOR_FAILURE');
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key !== 'string'))
    throw new PackageFailure('PUBLICATION_VALIDATOR_FAILURE');
  const keys = (ownKeys as string[]).sort(compareText);
  const ok = descriptors.ok;
  if (ok === undefined || 'get' in ok || 'set' in ok)
    throw new PackageFailure('PUBLICATION_VALIDATOR_FAILURE');
  if (ok.value === true && keys.length === 1 && keys[0] === 'ok') return true;
  if (
    ok.value !== false ||
    keys.length !== 2 ||
    keys[0] !== 'diagnostic' ||
    keys[1] !== 'ok'
  )
    throw new PackageFailure('PUBLICATION_VALIDATOR_FAILURE');
  const diagnosticDescriptor = descriptors.diagnostic;
  if (
    diagnosticDescriptor === undefined ||
    'get' in diagnosticDescriptor ||
    'set' in diagnosticDescriptor ||
    diagnosticDescriptor.value === null ||
    typeof diagnosticDescriptor.value !== 'object' ||
    types.isProxy(diagnosticDescriptor.value) ||
    Object.getPrototypeOf(diagnosticDescriptor.value) !== Object.prototype
  )
    throw new PackageFailure('PUBLICATION_VALIDATOR_FAILURE');
  const diagnosticDescriptors = Object.getOwnPropertyDescriptors(
    diagnosticDescriptor.value,
  );
  const diagnosticKeys = Reflect.ownKeys(diagnosticDescriptors);
  if (
    diagnosticKeys.some((key) => typeof key !== 'string') ||
    (diagnosticKeys as string[]).sort(compareText).join(',') !== 'code,location'
  )
    throw new PackageFailure('PUBLICATION_VALIDATOR_FAILURE');
  const code = diagnosticDescriptors.code;
  const location = diagnosticDescriptors.location;
  if (
    code === undefined ||
    location === undefined ||
    'get' in code ||
    'set' in code ||
    'get' in location ||
    'set' in location ||
    typeof code.value !== 'string' ||
    typeof location.value !== 'string' ||
    validatorFailures.get(code.value) !== location.value
  )
    throw new PackageFailure('PUBLICATION_VALIDATOR_FAILURE');
  return Object.freeze({ code: code.value, location: location.value });
}

function canonicalJson(value: unknown, limit: number, code: string): string {
  const pieces: string[] = [];
  let length = 0;
  const put = (text: string): void => {
    length += text.length;
    if (length > limit) throw new PackageFailure(code);
    pieces.push(text);
  };
  const write = (item: unknown): void => {
    if (item === null || typeof item !== 'object') {
      put(JSON.stringify(item));
      return;
    }
    if (Array.isArray(item)) {
      put('[');
      for (const [index, entry] of item.entries()) {
        if (index) put(',');
        write(entry);
      }
      put(']');
      return;
    }
    const record = item as Record<string, unknown>;
    put('{');
    for (const [index, key] of Object.keys(record)
      .sort(compareText)
      .entries()) {
      if (index) put(',');
      put(`${JSON.stringify(key)}:`);
      write(record[key]);
    }
    put('}');
  };
  write(value);
  return pieces.join('');
}

class PackageFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PackageFailure';
  }
}

/**
 * Build deterministic publication bytes after fresh target preflight. The
 * returned JSON string is immutable content, not durable storage or publication.
 */
export async function createPublicationPackage(
  formInput: unknown,
  mappingInput: unknown,
  describeObject: DescribeObject,
  validateXForm: ValidateXForm,
): Promise<PublicationPackageResult> {
  const authoring = exportAuthoringBundle(formInput, mappingInput);
  if (!authoring.ok) return rejected(authoring.diagnostics, 0);
  const workbook = exportXlsFormWorkbook(
    authoring.bundle.definition,
    authoring.bundle.mappings,
  );
  if (!workbook.ok) return rejected(workbook.diagnostics, 0);

  const preflight = await preflightPublicationDetails(
    authoring.bundle.definition,
    authoring.bundle.mappings,
    describeObject,
  );
  if (!preflight.ok)
    return rejected(preflight.diagnostics, preflight.requestCount);

  try {
    const validation = decodeValidationResult(
      await validateXForm(preflight.xml),
    );
    if (validation !== true)
      return rejected([validation], preflight.requestCount);
  } catch {
    return rejected(
      [{ code: 'PUBLICATION_VALIDATOR_FAILURE', location: 'validator' }],
      preflight.requestCount,
    );
  }
  try {
    const targetSchemaJson = canonicalJson(
      preflight.targetSchema,
      maxTargetSchemaJson,
      'PUBLICATION_PACKAGE_LIMIT',
    );
    const authoringSha256 = sha256(authoring.json);
    const xlsformSha256 = sha256(workbook.workbook);
    const targetSchemaSha256 = sha256(targetSchemaJson);
    const targetObjects = Object.freeze(
      preflight.targetSchema.objects.map(({ apiName }) => apiName),
    );
    const warnings = immutableDiagnostics(preflight.warnings);
    const packageJson = canonicalJson(
      {
        schemaVersion: 2,
        kind: 'kusanya-publication-package',
        audience: 'publisher-only',
        authoring: { json: authoring.json, sha256: authoringSha256 },
        targetSchema: { json: targetSchemaJson, sha256: targetSchemaSha256 },
        targetObjects,
        submissionPolicy: {
          dynamicRepeatCardinality: dynamicRepeatCardinalityPolicy,
        },
        warnings,
        xform: { xml: preflight.xml, sha256: preflight.xformSha256 },
        xlsform: {
          base64: Buffer.from(workbook.workbook).toString('base64'),
          sha256: xlsformSha256,
        },
      },
      maxPackageJson,
      'PUBLICATION_PACKAGE_LIMIT',
    );
    return Object.freeze({
      ok: true,
      validation: 'odk-validate-1.20.0',
      audience: 'publisher-only',
      packageJson,
      packageSha256: sha256(packageJson),
      authoringSha256,
      xformSha256: preflight.xformSha256,
      xlsformSha256,
      targetSchemaSha256,
      targetObjects,
      requestCount: preflight.requestCount,
      warnings,
    });
  } catch (error) {
    if (error instanceof PackageFailure)
      return rejected(
        [{ code: error.code, location: 'package' }],
        preflight.requestCount,
      );
    throw error;
  }
}

/** Check a stored content address without parsing or trusting package contents. */
export function verifyPublicationPackageDigest(
  packageJson: unknown,
  expectedSha256: unknown,
): boolean {
  return (
    typeof packageJson === 'string' &&
    packageJson.length <= maxPackageJson &&
    typeof expectedSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(expectedSha256) &&
    sha256(packageJson) === expectedSha256
  );
}
