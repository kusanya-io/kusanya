/** One-call, namespace-aware transport for a bounded raw-submission receipt. */
import { types } from 'node:util';
import { createSalesforceNames } from '../salesforce-names.js';
import type {
  DeliverSubmissionBatch,
  SubmissionDeliveryOutcome,
  SubmissionDeliveryRequest,
} from './submission-dispatcher.js';

const maximumRequestBytes = 1_500_000;
const maximumResponseBytes = 262_144;
const tokenPattern = /^[\x21-\x7e]+$/;
const relayIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class SalesforceSubmissionTransportError extends Error {
  constructor() {
    super('SALESFORCE_SUBMISSION_TRANSPORT');
    this.name = 'SalesforceSubmissionTransportError';
  }
}

const fail = (): never => {
  throw new SalesforceSubmissionTransportError();
};

function record(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    fail();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

async function boundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    response.redirected ||
    response.status !== 200 ||
    response.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase() !== 'application/json'
  )
    fail();
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!Number.isSafeInteger(Number(declared)) ||
      Number(declared) < 0 ||
      Number(declared) > maximumResponseBytes)
  )
    fail();
  const reader = response.body?.getReader();
  if (reader === undefined) throw new SalesforceSubmissionTransportError();
  const cancel = (): void => void reader.cancel().catch(() => undefined);
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maximumResponseBytes) {
        await reader.cancel().catch(() => undefined);
        fail();
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof SalesforceSubmissionTransportError) throw error;
    fail();
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
    fail();
  }
}

function decodeOutcomes(
  value: unknown,
  expectedRelayIds: readonly string[],
): readonly SubmissionDeliveryOutcome[] {
  const envelope = record(value);
  const outcomes = envelope.outcomes;
  if (
    Object.keys(envelope).sort().join(',') !== 'outcomes,schemaVersion' ||
    envelope.schemaVersion !== 1 ||
    !Array.isArray(outcomes) ||
    types.isProxy(outcomes) ||
    Object.getPrototypeOf(outcomes) !== Array.prototype ||
    outcomes.length !== expectedRelayIds.length
  )
    fail();
  const decodedOutcomes = outcomes as unknown[];
  const expected = new Set(expectedRelayIds);
  const found = new Map<string, SubmissionDeliveryOutcome>();
  for (const value of decodedOutcomes) {
    const outcome = record(value);
    if (
      Object.keys(outcome).sort().join(',') !== 'code,relayId,status' ||
      typeof outcome.relayId !== 'string' ||
      !relayIdPattern.test(outcome.relayId) ||
      !expected.has(outcome.relayId) ||
      found.has(outcome.relayId) ||
      typeof outcome.code !== 'string' ||
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(outcome.code) ||
      typeof outcome.status !== 'string' ||
      !['mapped', 'received', 'retry', 'dead'].includes(outcome.status)
    )
      fail();
    const relayId = outcome.relayId as string;
    found.set(
      relayId,
      Object.freeze({
        relayId,
        disposition:
          outcome.status === 'mapped'
            ? 'committed'
            : outcome.status === 'dead'
              ? 'dead'
              : 'retry',
      }),
    );
  }
  if (found.size !== expected.size) fail();
  return Object.freeze(expectedRelayIds.map((relayId) => found.get(relayId)!));
}

function requestItems(request: SubmissionDeliveryRequest): {
  body: string;
  selected: readonly string[];
  deferred: readonly SubmissionDeliveryOutcome[];
} {
  const items: Record<string, unknown>[] = [];
  const selected: string[] = [];
  let body = JSON.stringify({ schemaVersion: 1, submissions: items });
  let index = 0;
  for (; index < request.submissions.length; index++) {
    const submission = request.submissions[index]!;
    const item = {
      relayId: submission.relayId,
      formVersionId: submission.formVersionId,
      instanceId: submission.instanceId,
      channel: submission.channel,
      xmlSha256: submission.xmlSha256,
      rawXmlBase64: Buffer.from(submission.rawXml).toString('base64'),
    };
    const candidate = JSON.stringify({
      schemaVersion: 1,
      submissions: [...items, item],
    });
    if (Buffer.byteLength(candidate, 'utf8') > maximumRequestBytes) break;
    items.push(item);
    selected.push(submission.relayId);
    body = candidate;
  }
  if (selected.length === 0) fail();
  return {
    body,
    selected: Object.freeze(selected),
    deferred: Object.freeze(
      request.submissions.slice(index).map((submission) =>
        Object.freeze({
          relayId: submission.relayId,
          disposition: 'retry' as const,
        }),
      ),
    ),
  };
}

/** Build a transport whose only network capability is the ingest Apex resource. */
export function createSalesforceSubmissionDelivery(
  fetchImplementation: FetchImplementation = fetch,
): DeliverSubmissionBatch {
  if (typeof fetchImplementation !== 'function') fail();
  return async (
    request: SubmissionDeliveryRequest,
  ): Promise<readonly SubmissionDeliveryOutcome[]> => {
    if (request.signal.aborted) fail();
    const batch = requestItems(request);
    const accessToken = await request.session.getAccessToken();
    if (
      typeof accessToken !== 'string' ||
      accessToken.length < 1 ||
      accessToken.length > 4_096 ||
      !tokenPattern.test(accessToken)
    )
      fail();
    const path = createSalesforceNames(
      request.session.namespacePrefix,
    ).apexRestPath('v1/submissions/ingest');
    const response = await fetchImplementation(
      `${request.session.instanceOrigin}${path}`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json; charset=UTF-8',
        },
        body: batch.body,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'manual',
        signal: request.signal,
      },
    ).catch(() => fail());
    const delivered = decodeOutcomes(
      await boundedJson(response, request.signal),
      batch.selected,
    );
    return Object.freeze([...delivered, ...batch.deferred]);
  };
}
