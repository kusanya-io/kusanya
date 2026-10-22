/** Read-only inspection of one recorded publication attempt; performs no mutation. */
import { types } from 'node:util';
import { createSalesforceNames } from '../salesforce-names.js';
import type { TenantSalesforceSession } from '../tenant/salesforce-session.js';

const apiVersion = '64.0';
const maxResponseBytes = 65_536;
const tokenPattern = /^[\x21-\x7e]+$/;
const idPattern = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const versionIdPattern = /^068[A-Za-z0-9]{15}$/;
const documentIdPattern = /^069[A-Za-z0-9]{15}$/;
const digestPattern = /^[0-9a-f]{64}$/;

export interface SalesforcePublicationInspectionRequest {
  readonly formVersionId: string;
  readonly publicationDigest: string;
  readonly xformVersionId: string;
  readonly xlsformVersionId: string;
}

export type SalesforcePublicationInspectionResult =
  | Readonly<{
      ok: true;
      status: 'committed' | 'unlinked' | 'artifacts_missing';
      requestCount: number;
    }>
  | Readonly<{
      ok: false;
      code: 'PUBLICATION_RECONCILIATION_INSPECTION';
      requestCount: number;
    }>;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

class InspectionFailure extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new InspectionFailure();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    throw new InspectionFailure();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).sort().join(',') !== expected.sort().join(','))
    throw new InspectionFailure();
}

function request(value: SalesforcePublicationInspectionRequest) {
  const decoded = record(value);
  exactKeys(decoded, [
    'formVersionId',
    'publicationDigest',
    'xformVersionId',
    'xlsformVersionId',
  ]);
  if (
    typeof decoded.formVersionId !== 'string' ||
    !idPattern.test(decoded.formVersionId) ||
    typeof decoded.publicationDigest !== 'string' ||
    !digestPattern.test(decoded.publicationDigest) ||
    typeof decoded.xformVersionId !== 'string' ||
    !versionIdPattern.test(decoded.xformVersionId) ||
    typeof decoded.xlsformVersionId !== 'string' ||
    !versionIdPattern.test(decoded.xlsformVersionId) ||
    decoded.xformVersionId === decoded.xlsformVersionId
  )
    throw new InspectionFailure();
  return {
    formVersionId: decoded.formVersionId,
    publicationDigest: decoded.publicationDigest,
    xformVersionId: decoded.xformVersionId,
    xlsformVersionId: decoded.xlsformVersionId,
  };
}

async function bytes(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maxResponseBytes
    )
      throw new InspectionFailure();
  }
  if (response.body === null) throw new InspectionFailure();
  const reader = response.body.getReader();
  const cancel = (): void => void reader.cancel().catch(() => undefined);
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxResponseBytes) throw new InspectionFailure();
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof InspectionFailure) throw error;
    throw new InspectionFailure();
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function json(value: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value));
  } catch {
    throw new InspectionFailure();
  }
}

/** Inspect exact stored identities. No method other than GET is reachable. */
export async function inspectSalesforcePublication(
  session: TenantSalesforceSession,
  requestValue: SalesforcePublicationInspectionRequest,
  perRequestTimeoutMs: number,
  overallTimeoutMs: number,
  fetchImplementation: FetchImplementation = fetch,
): Promise<SalesforcePublicationInspectionResult> {
  let selected: ReturnType<typeof request>;
  let names: ReturnType<typeof createSalesforceNames>;
  try {
    selected = request(requestValue);
    if (
      session === null ||
      typeof session !== 'object' ||
      types.isProxy(session)
    )
      throw new InspectionFailure();
    const sessionDescriptors = Object.getOwnPropertyDescriptors(session);
    const expectedSessionKeys = [
      'tenantId',
      'salesforceOrgId',
      'instanceOrigin',
      'namespacePrefix',
      'credentialVersion',
      'getAccessToken',
    ];
    if (
      Reflect.ownKeys(sessionDescriptors).some(
        (key) =>
          typeof key !== 'string' ||
          !Object.hasOwn(sessionDescriptors[key]!, 'value'),
      ) ||
      Object.keys(sessionDescriptors).sort().join(',') !==
        expectedSessionKeys.sort().join(',') ||
      sessionDescriptors.getAccessToken?.enumerable !== false ||
      !Number.isSafeInteger(perRequestTimeoutMs) ||
      perRequestTimeoutMs < 1 ||
      perRequestTimeoutMs > 30_000 ||
      !Number.isSafeInteger(overallTimeoutMs) ||
      overallTimeoutMs < perRequestTimeoutMs ||
      overallTimeoutMs > 120_000 ||
      typeof fetchImplementation !== 'function'
    )
      throw new InspectionFailure();
    const values: Record<string, unknown> = Object.fromEntries(
      Object.entries(sessionDescriptors).map(([key, descriptor]) => [
        key,
        descriptor.value,
      ]),
    );
    if (
      typeof values.instanceOrigin !== 'string' ||
      new URL(values.instanceOrigin).protocol !== 'https:' ||
      new URL(values.instanceOrigin).origin !== values.instanceOrigin ||
      !new URL(values.instanceOrigin).hostname.endsWith('.salesforce.com') ||
      typeof values.namespacePrefix !== 'string' ||
      typeof values.getAccessToken !== 'function'
    )
      throw new InspectionFailure();
    names = createSalesforceNames(values.namespacePrefix);
  } catch {
    return Object.freeze({
      ok: false,
      code: 'PUBLICATION_RECONCILIATION_INSPECTION',
      requestCount: 0,
    });
  }

  const deadline = performance.now() + overallTimeoutMs;
  let requestCount = 0;
  const get = async (path: string): Promise<unknown> => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new InspectionFailure();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(perRequestTimeoutMs, Math.ceil(remaining)),
    );
    timer.unref();
    try {
      const token = await Promise.race([
        session.getAccessToken(),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            'abort',
            () => reject(new InspectionFailure()),
            { once: true },
          ),
        ),
      ]);
      if (
        typeof token !== 'string' ||
        token.length < 1 ||
        token.length > 4096 ||
        !tokenPattern.test(token)
      )
        throw new InspectionFailure();
      requestCount++;
      const response = await Promise.race([
        fetchImplementation(`${session.instanceOrigin}${path}`, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
          },
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'manual',
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            'abort',
            () => reject(new InspectionFailure()),
            { once: true },
          ),
        ),
      ]);
      if (
        response.status !== 200 ||
        response.redirected ||
        response.headers
          .get('content-type')
          ?.split(';', 1)[0]
          ?.trim()
          .toLowerCase() !== 'application/json'
      )
        throw new InspectionFailure();
      return json(await bytes(response, controller.signal));
    } catch {
      throw new InspectionFailure();
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const objectName = names.kusanyaObject('Form_Version__c');
    const statusField = names.kusanyaField('Status__c');
    const digestField = names.kusanyaField('Publication_Digest__c');
    const xformField = names.kusanyaField('XForm_Version__c');
    const xlsformField = names.kusanyaField('XLSForm_Version__c');
    const fields = ['Id', statusField, digestField, xformField, xlsformField];
    const form = record(
      await get(
        `/services/data/v${apiVersion}/sobjects/${objectName}/${selected.formVersionId}?fields=${fields.join(',')}`,
      ),
    );
    exactKeys(form, ['attributes', ...fields]);
    if (form.Id !== selected.formVersionId) throw new InspectionFailure();
    const committed =
      (form[statusField] === 'Published' ||
        form[statusField] === 'Superseded') &&
      form[digestField] === selected.publicationDigest &&
      form[xformField] === selected.xformVersionId &&
      form[xlsformField] === selected.xlsformVersionId;
    if (committed)
      return Object.freeze({ ok: true, status: 'committed', requestCount });
    if (
      form[statusField] !== 'Draft' ||
      form[digestField] !== null ||
      form[xformField] !== null ||
      form[xlsformField] !== null
    )
      throw new InspectionFailure();

    const soql =
      'SELECT Id,ContentDocumentId,Title,FileExtension FROM ContentVersion ' +
      `WHERE Id IN ('${selected.xformVersionId}','${selected.xlsformVersionId}')`;
    const query = record(
      await get(
        `/services/data/v${apiVersion}/query?q=${encodeURIComponent(soql)}`,
      ),
    );
    exactKeys(query, ['totalSize', 'done', 'records']);
    if (
      query.done !== true ||
      !Number.isSafeInteger(query.totalSize) ||
      !Array.isArray(query.records) ||
      query.totalSize !== query.records.length ||
      query.records.length > 2
    )
      throw new InspectionFailure();
    if (query.records.length === 0)
      return Object.freeze({
        ok: true,
        status: 'artifacts_missing',
        requestCount,
      });
    if (query.records.length !== 2) throw new InspectionFailure();
    const expected = new Map([
      [
        selected.xformVersionId,
        [`kusanya-${selected.publicationDigest}-xform`, 'xml'],
      ],
      [
        selected.xlsformVersionId,
        [`kusanya-${selected.publicationDigest}-xlsform`, 'xlsx'],
      ],
    ]);
    const documents = new Set<string>();
    for (const value of query.records) {
      const row = record(value);
      exactKeys(row, [
        'attributes',
        'Id',
        'ContentDocumentId',
        'Title',
        'FileExtension',
      ]);
      if (typeof row.Id !== 'string') throw new InspectionFailure();
      const identity = expected.get(row.Id);
      if (
        identity === undefined ||
        row.Title !== identity[0] ||
        row.FileExtension !== identity[1] ||
        typeof row.ContentDocumentId !== 'string' ||
        !documentIdPattern.test(row.ContentDocumentId)
      )
        throw new InspectionFailure();
      documents.add(row.ContentDocumentId);
      expected.delete(row.Id);
    }
    if (expected.size !== 0 || documents.size !== 2)
      throw new InspectionFailure();
    return Object.freeze({ ok: true, status: 'unlinked', requestCount });
  } catch {
    return Object.freeze({
      ok: false,
      code: 'PUBLICATION_RECONCILIATION_INSPECTION',
      requestCount,
    });
  }
}
