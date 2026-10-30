/** Fresh-org XLSForm import/compile equivalence harness for brief C10.10. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { compileForm } from '../compiler/compile.js';
import type { Diagnostic, FormDefinition } from '../compiler/types.js';
import { exportAuthoringBundle } from './bundle.js';
import { importEditedXlsFormWorkbook } from './xlsx-workbook.js';

const idPattern = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const tokenPattern = /^[\x21-\x7e]+$/;
const maxResponseBytes = 5_000_000;

export interface SalesforceRoundTripConfiguration {
  readonly instanceOrigin: string;
  readonly getAccessToken: () => Promise<unknown>;
  readonly perRequestTimeoutMs: number;
  readonly overallTimeoutMs: number;
}

export type SalesforceRoundTripResult =
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }
  | {
      readonly ok: true;
      readonly formVersionId: string;
      readonly sourceSha256: string;
      readonly importedSha256: string;
      readonly requestCount: 2;
    };

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

class RoundTripFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function failure(
  code: string,
  location = 'roundtrip',
): SalesforceRoundTripResult {
  return { ok: false, diagnostics: [{ code, location }] };
}

function record(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new RoundTripFailure('XLSFORM_SALESFORCE_RESPONSE');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    throw new RoundTripFailure('XLSFORM_SALESFORCE_RESPONSE');
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const result = record(value);
  const actual = Object.keys(result);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(result, key))
  )
    throw new RoundTripFailure('XLSFORM_SALESFORCE_RESPONSE');
  return result;
}

function configuration(value: SalesforceRoundTripConfiguration): {
  origin: string;
  token: () => Promise<unknown>;
  perRequest: number;
  overall: number;
} {
  const input = exact(value, [
    'instanceOrigin',
    'getAccessToken',
    'perRequestTimeoutMs',
    'overallTimeoutMs',
  ]);
  if (typeof input.instanceOrigin !== 'string')
    throw new RoundTripFailure('XLSFORM_SALESFORCE_INPUT');
  let parsed: URL;
  try {
    parsed = new URL(input.instanceOrigin);
  } catch {
    throw new RoundTripFailure('XLSFORM_SALESFORCE_INPUT');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== input.instanceOrigin ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    !parsed.hostname.endsWith('.salesforce.com') ||
    typeof input.getAccessToken !== 'function' ||
    !Number.isSafeInteger(input.perRequestTimeoutMs) ||
    (input.perRequestTimeoutMs as number) < 1 ||
    (input.perRequestTimeoutMs as number) > 30_000 ||
    !Number.isSafeInteger(input.overallTimeoutMs) ||
    (input.overallTimeoutMs as number) <
      (input.perRequestTimeoutMs as number) ||
    (input.overallTimeoutMs as number) > 120_000
  )
    throw new RoundTripFailure('XLSFORM_SALESFORCE_INPUT');
  return {
    origin: input.instanceOrigin,
    token: input.getAccessToken as () => Promise<unknown>,
    perRequest: input.perRequestTimeoutMs as number,
    overall: input.overallTimeoutMs as number,
  };
}

async function body(response: Response, signal: AbortSignal): Promise<unknown> {
  if (
    response.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase() !== 'application/json' ||
    response.body === null
  )
    throw new RoundTripFailure('XLSFORM_SALESFORCE_RESPONSE');
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!Number.isSafeInteger(Number(declared)) ||
      Number(declared) < 0 ||
      Number(declared) > maxResponseBytes)
  )
    throw new RoundTripFailure('XLSFORM_SALESFORCE_RESPONSE');
  const reader = response.body.getReader();
  const cancel = (): void => void reader.cancel().catch(() => undefined);
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RoundTripFailure('XLSFORM_SALESFORCE_RESPONSE');
      }
      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new RoundTripFailure('XLSFORM_SALESFORCE_RESPONSE');
  }
}

function normalized(definition: FormDefinition): FormDefinition {
  return {
    ...definition,
    form: { ...definition.form, key: 'normalized_form_identity' },
    questions: definition.questions.map((question) => ({ ...question })),
    choiceLists: definition.choiceLists.map((list) => ({
      ...list,
      choices: list.choices.map((choice) => ({ ...choice })),
    })),
    skipRules: definition.skipRules.map((rule) => ({ ...rule })),
  };
}

const digest = (xml: string): string =>
  createHash('sha256').update(xml, 'utf8').digest('hex');

/**
 * Import one validated workbook into Salesforce, read it back through the
 * integration snapshot boundary and prove normalized compiled XML byte equality.
 */
export async function verifySalesforceXlsFormRoundTrip(
  configurationValue: SalesforceRoundTripConfiguration,
  workbook: unknown,
  fetchImplementation: FetchImplementation = fetch,
): Promise<SalesforceRoundTripResult> {
  const imported = importEditedXlsFormWorkbook(workbook);
  if (!imported.ok) return imported;
  let config: ReturnType<typeof configuration>;
  try {
    config = configuration(configurationValue);
  } catch {
    return failure('XLSFORM_SALESFORCE_INPUT');
  }
  const deadline = performance.now() + config.overall;
  const post = async (
    path: string,
    payload: string,
    status: number,
  ): Promise<unknown> => {
    const remaining = deadline - performance.now();
    if (remaining <= 0)
      throw new RoundTripFailure('XLSFORM_SALESFORCE_TIMEOUT');
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(config.perRequest, Math.ceil(remaining)),
    );
    timer.unref();
    try {
      const operation = async (): Promise<unknown> => {
        const supplied = await config.token();
        if (
          typeof supplied !== 'string' ||
          supplied.length < 1 ||
          supplied.length > 4096 ||
          !tokenPattern.test(supplied)
        )
          throw new RoundTripFailure('XLSFORM_SALESFORCE_TOKEN');
        if (controller.signal.aborted)
          throw new RoundTripFailure('XLSFORM_SALESFORCE_TIMEOUT');
        const response = await fetchImplementation(
          `${config.origin}/services/apexrest${path}`,
          {
            method: 'POST',
            headers: {
              accept: 'application/json',
              authorization: `Bearer ${supplied}`,
              'content-type': 'application/json; charset=UTF-8',
            },
            body: payload,
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'manual',
            signal: controller.signal,
          },
        );
        if (response.status !== status || response.redirected)
          throw new RoundTripFailure('XLSFORM_SALESFORCE_RESPONSE');
        return await body(response, controller.signal);
      };
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            'abort',
            () => reject(new RoundTripFailure('XLSFORM_SALESFORCE_TIMEOUT')),
            { once: true },
          ),
        ),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const created = exact(
      await post(
        '/v1/definitions/import',
        JSON.stringify({
          schemaVersion: 1,
          definition: imported.bundle.definition,
          mappingBundle: imported.bundle.mappings,
        }),
        201,
      ),
      ['schemaVersion', 'formVersionId'],
    );
    if (
      created.schemaVersion !== 1 ||
      typeof created.formVersionId !== 'string' ||
      !idPattern.test(created.formVersionId)
    )
      throw new RoundTripFailure('XLSFORM_SALESFORCE_RESPONSE');
    const snapshot = exact(
      await post(
        '/v1/publications/definition',
        JSON.stringify({
          schemaVersion: 1,
          formVersionId: created.formVersionId,
        }),
        200,
      ),
      ['schemaVersion', 'definition', 'mappingBundle'],
    );
    if (snapshot.schemaVersion !== 1)
      throw new RoundTripFailure('XLSFORM_SALESFORCE_RESPONSE');
    const restored = exportAuthoringBundle(
      snapshot.definition,
      snapshot.mappingBundle,
    );
    if (!restored.ok) return failure('XLSFORM_SALESFORCE_SNAPSHOT');
    const source = compileForm(normalized(imported.bundle.definition));
    const destination = compileForm(normalized(restored.bundle.definition));
    if (!source.ok || !destination.ok)
      return failure('XLSFORM_SALESFORCE_COMPILE');
    const sourceSha256 = digest(source.xml);
    const importedSha256 = digest(destination.xml);
    if (source.xml !== destination.xml)
      return failure('XLSFORM_SALESFORCE_MISMATCH');
    return {
      ok: true,
      formVersionId: created.formVersionId,
      sourceSha256,
      importedSha256,
      requestCount: 2,
    };
  } catch (error) {
    return failure(
      error instanceof RoundTripFailure
        ? error.code
        : 'XLSFORM_SALESFORCE_FAILED',
    );
  }
}
