/** Bounded Salesforce Files upload and exact-byte attestation transport. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';
import { verifyPublicationPackageDigest } from './package.js';

export const salesforceArtifactApiVersion = '64.0';
const maxPackageCharacters = 8_000_000;
const maxJsonBytes = 65_536;
const tokenPattern = /^[\x21-\x7e]+$/;
const digestPattern = /^[0-9a-f]{64}$/;
const idPattern = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

export interface SalesforceArtifactConfiguration {
  readonly instanceOrigin: string;
  readonly getAccessToken: () => Promise<unknown>;
  readonly perRequestTimeoutMs: number;
  readonly overallTimeoutMs: number;
}

export interface PublicationPackageIdentity {
  readonly packageJson: string;
  readonly packageSha256: string;
}

type FailureCode =
  | 'PUBLICATION_ARTIFACT_PACKAGE'
  | 'PUBLICATION_ARTIFACT_UPLOAD'
  | 'PUBLICATION_ARTIFACT_READBACK'
  | 'PUBLICATION_ARTIFACT_MISMATCH'
  | 'PUBLICATION_ARTIFACT_CLEANUP';

export type SalesforceArtifactResult =
  | Readonly<{
      ok: true;
      xformVersionId: string;
      xlsformVersionId: string;
      requestCount: number;
    }>
  | Readonly<{
      ok: false;
      diagnostic: Readonly<{ code: FailureCode; location: 'artifacts' }>;
      requestCount: number;
    }>;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

class ArtifactFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
    this.name = 'ArtifactFailure';
  }
}
const fail = (code: FailureCode): never => {
  throw new ArtifactFailure(code);
};

function record(value: unknown, code: FailureCode): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    fail(code);
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  code: FailureCode = 'PUBLICATION_ARTIFACT_PACKAGE',
): void {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(','))
    fail(code);
}

function decodeBase64(value: unknown): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length > maxPackageCharacters ||
    (value.length > 0 &&
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value,
      ))
  )
    fail('PUBLICATION_ARTIFACT_PACKAGE');
  const input = value as string;
  const bytes = Buffer.from(input, 'base64');
  if (bytes.toString('base64') !== input) fail('PUBLICATION_ARTIFACT_PACKAGE');
  return new Uint8Array(bytes);
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodePackage(identityValue: unknown): {
  digest: string;
  xform: Uint8Array;
  xlsform: Uint8Array;
  xformBase64: string;
  xlsformBase64: string;
} {
  const identity = record(identityValue, 'PUBLICATION_ARTIFACT_PACKAGE');
  exactKeys(identity, ['packageJson', 'packageSha256']);
  const { packageJson, packageSha256 } = identity;
  if (
    typeof packageJson !== 'string' ||
    packageJson.length > maxPackageCharacters ||
    typeof packageSha256 !== 'string' ||
    !digestPattern.test(packageSha256) ||
    !verifyPublicationPackageDigest(packageJson, packageSha256)
  )
    fail('PUBLICATION_ARTIFACT_PACKAGE');
  const packageText = packageJson as string;
  const packageDigest = packageSha256 as string;
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageText);
  } catch {
    fail('PUBLICATION_ARTIFACT_PACKAGE');
  }
  const body = record(parsed, 'PUBLICATION_ARTIFACT_PACKAGE');
  exactKeys(body, [
    'schemaVersion',
    'kind',
    'audience',
    'authoring',
    'targetSchema',
    'targetObjects',
    'submissionPolicy',
    'warnings',
    'xform',
    'xlsform',
  ]);
  if (
    body.schemaVersion !== 2 ||
    body.kind !== 'kusanya-publication-package' ||
    body.audience !== 'publisher-only'
  )
    fail('PUBLICATION_ARTIFACT_PACKAGE');
  const xform = record(body.xform, 'PUBLICATION_ARTIFACT_PACKAGE');
  const xlsform = record(body.xlsform, 'PUBLICATION_ARTIFACT_PACKAGE');
  exactKeys(xform, ['xml', 'sha256']);
  exactKeys(xlsform, ['base64', 'sha256']);
  if (
    typeof xform.xml !== 'string' ||
    typeof xform.sha256 !== 'string' ||
    !digestPattern.test(xform.sha256) ||
    typeof xlsform.sha256 !== 'string' ||
    !digestPattern.test(xlsform.sha256)
  )
    fail('PUBLICATION_ARTIFACT_PACKAGE');
  const xformXml = xform.xml as string;
  const xformHash = xform.sha256 as string;
  const xlsformHash = xlsform.sha256 as string;
  const xformBytes = new TextEncoder().encode(xformXml);
  const xlsformBytes = decodeBase64(xlsform.base64);
  if (sha256(xformBytes) !== xformHash || sha256(xlsformBytes) !== xlsformHash)
    fail('PUBLICATION_ARTIFACT_PACKAGE');
  return {
    digest: packageDigest,
    xform: xformBytes,
    xlsform: xlsformBytes,
    xformBase64: Buffer.from(xformBytes).toString('base64'),
    xlsformBase64: xlsform.base64 as string,
  };
}

function decodeConfiguration(value: unknown): {
  origin: string;
  token: () => Promise<unknown>;
  perRequest: number;
  overall: number;
} {
  const input = record(value, 'PUBLICATION_ARTIFACT_PACKAGE');
  exactKeys(input, [
    'instanceOrigin',
    'getAccessToken',
    'perRequestTimeoutMs',
    'overallTimeoutMs',
  ]);
  let origin: string | undefined;
  try {
    if (typeof input.instanceOrigin !== 'string')
      fail('PUBLICATION_ARTIFACT_PACKAGE');
    origin = input.instanceOrigin as string;
  } catch {
    fail('PUBLICATION_ARTIFACT_PACKAGE');
  }
  const url = new URL(origin!);
  if (
    url.protocol !== 'https:' ||
    url.origin !== origin ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    !url.hostname.endsWith('.salesforce.com') ||
    typeof input.getAccessToken !== 'function' ||
    !Number.isSafeInteger(input.perRequestTimeoutMs) ||
    (input.perRequestTimeoutMs as number) < 1 ||
    (input.perRequestTimeoutMs as number) > 60_000 ||
    !Number.isSafeInteger(input.overallTimeoutMs) ||
    (input.overallTimeoutMs as number) <
      (input.perRequestTimeoutMs as number) ||
    (input.overallTimeoutMs as number) > 180_000
  )
    fail('PUBLICATION_ARTIFACT_PACKAGE');
  return {
    origin: url.origin,
    token: input.getAccessToken as () => Promise<unknown>,
    perRequest: input.perRequestTimeoutMs as number,
    overall: input.overallTimeoutMs as number,
  };
}

function refusal(
  code: FailureCode,
  requestCount: number,
): SalesforceArtifactResult {
  return Object.freeze({
    ok: false,
    diagnostic: Object.freeze({ code, location: 'artifacts' as const }),
    requestCount,
  });
}

async function responseBytes(
  response: Response,
  maximum: number,
  code: FailureCode,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum)
      throw new ArtifactFailure(code);
  }
  const body = response.body;
  if (body === null) {
    if (maximum === 0) return new Uint8Array();
    throw new ArtifactFailure(code);
  }
  const reader = body.getReader();
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
      if (length > maximum) {
        await reader.cancel().catch(() => undefined);
        fail(code);
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof ArtifactFailure) throw error;
    fail(code);
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
  return bytes;
}

function json(bytes: Uint8Array, code: FailureCode): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail(code);
  }
}

function hasJsonMediaType(response: Response): boolean {
  return (
    response.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase() === 'application/json'
  );
}

/** Upload both artifacts atomically and return IDs only after exact readback. */
export async function attestSalesforcePublicationArtifacts(
  configurationValue: SalesforceArtifactConfiguration,
  identityValue: PublicationPackageIdentity,
  fetchImplementation: FetchImplementation = fetch,
): Promise<SalesforceArtifactResult> {
  let artifacts: ReturnType<typeof decodePackage>;
  let configuration: ReturnType<typeof decodeConfiguration>;
  try {
    artifacts = decodePackage(identityValue);
    configuration = decodeConfiguration(configurationValue);
  } catch {
    return refusal('PUBLICATION_ARTIFACT_PACKAGE', 0);
  }
  const deadline = performance.now() + configuration.overall;
  let requestCount = 0;
  const send = async (
    path: string,
    init: RequestInit,
    maximum: number,
    code: FailureCode,
  ): Promise<{ response: Response; bytes: Uint8Array }> => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) fail(code);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(configuration.perRequest, Math.ceil(remaining)),
    );
    timer.unref();
    const timeout = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new ArtifactFailure(code)),
        { once: true },
      );
    });
    const operation = async (): Promise<{
      response: Response;
      bytes: Uint8Array;
    }> => {
      const token = await configuration.token();
      if (
        typeof token !== 'string' ||
        token.length < 1 ||
        token.length > 4096 ||
        !tokenPattern.test(token)
      )
        fail(code);
      const accessToken = token as string;
      requestCount++;
      const response = await fetchImplementation(
        `${configuration.origin}/services/data/v${salesforceArtifactApiVersion}${path}`,
        {
          ...init,
          headers: { ...init.headers, authorization: `Bearer ${accessToken}` },
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'manual',
          signal: controller.signal,
        },
      );
      if (!response.ok || response.redirected) fail(code);
      return {
        response,
        bytes: await responseBytes(response, maximum, code, controller.signal),
      };
    };
    try {
      return await Promise.race([operation(), timeout]);
    } catch (error) {
      if (error instanceof ArtifactFailure) throw error;
      throw new ArtifactFailure(code);
    } finally {
      clearTimeout(timer);
    }
  };

  let stored:
    { versions: [string, string]; documents: [string, string] } | undefined;
  const cleanup = async (): Promise<boolean> => {
    if (!stored) return false;
    let success = true;
    for (const id of stored.documents) {
      try {
        const deleted = await send(
          `/sobjects/ContentDocument/${encodeURIComponent(id)}`,
          { method: 'DELETE', headers: { accept: 'application/json' } },
          0,
          'PUBLICATION_ARTIFACT_CLEANUP',
        );
        success = success && deleted.response.status === 204;
      } catch {
        success = false;
      }
    }
    return success;
  };

  try {
    const upload = await send(
      '/composite/sobjects',
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({
          allOrNone: true,
          records: [
            {
              attributes: { type: 'ContentVersion' },
              Title: `kusanya-${artifacts.digest}-xform`,
              PathOnClient: `${artifacts.digest}.xml`,
              VersionData: artifacts.xformBase64,
            },
            {
              attributes: { type: 'ContentVersion' },
              Title: `kusanya-${artifacts.digest}-xlsform`,
              PathOnClient: `${artifacts.digest}.xlsx`,
              VersionData: artifacts.xlsformBase64,
            },
          ],
        }),
      },
      maxJsonBytes,
      'PUBLICATION_ARTIFACT_UPLOAD',
    );
    if (upload.response.status !== 200 || !hasJsonMediaType(upload.response))
      fail('PUBLICATION_ARTIFACT_UPLOAD');
    const saves = json(upload.bytes, 'PUBLICATION_ARTIFACT_UPLOAD');
    if (!Array.isArray(saves) || saves.length !== 2)
      fail('PUBLICATION_ARTIFACT_UPLOAD');
    const versions = (saves as unknown[]).map((item) => {
      const saved = record(item, 'PUBLICATION_ARTIFACT_UPLOAD');
      exactKeys(
        saved,
        ['id', 'success', 'errors'],
        'PUBLICATION_ARTIFACT_UPLOAD',
      );
      if (
        saved.success !== true ||
        typeof saved.id !== 'string' ||
        !idPattern.test(saved.id) ||
        !Array.isArray(saved.errors) ||
        saved.errors.length !== 0
      )
        fail('PUBLICATION_ARTIFACT_UPLOAD');
      return saved.id;
    }) as [string, string];
    const metadata = await send(
      `/composite/sobjects/ContentVersion?ids=${versions.map(encodeURIComponent).join(',')}&fields=Id,ContentDocumentId,IsLatest,FileExtension`,
      { method: 'GET', headers: { accept: 'application/json' } },
      maxJsonBytes,
      'PUBLICATION_ARTIFACT_READBACK',
    );
    if (
      metadata.response.status !== 200 ||
      !hasJsonMediaType(metadata.response)
    )
      fail('PUBLICATION_ARTIFACT_READBACK');
    const rows = json(metadata.bytes, 'PUBLICATION_ARTIFACT_READBACK');
    if (!Array.isArray(rows) || rows.length !== 2)
      fail('PUBLICATION_ARTIFACT_READBACK');
    const documents = (rows as unknown[]).map((item, index) => {
      const row = record(item, 'PUBLICATION_ARTIFACT_READBACK');
      exactKeys(
        row,
        ['attributes', 'Id', 'ContentDocumentId', 'IsLatest', 'FileExtension'],
        'PUBLICATION_ARTIFACT_READBACK',
      );
      if (
        row.Id !== versions[index] ||
        typeof row.ContentDocumentId !== 'string' ||
        !idPattern.test(row.ContentDocumentId) ||
        row.IsLatest !== true ||
        row.FileExtension !== (index === 0 ? 'xml' : 'xlsx')
      )
        fail('PUBLICATION_ARTIFACT_READBACK');
      return row.ContentDocumentId;
    }) as [string, string];
    if (documents[0] === documents[1]) fail('PUBLICATION_ARTIFACT_READBACK');
    stored = { versions, documents };
    for (const [index, expected] of [
      artifacts.xform,
      artifacts.xlsform,
    ].entries()) {
      const downloaded = await send(
        `/sobjects/ContentVersion/${encodeURIComponent(versions[index]!)}/VersionData`,
        { method: 'GET', headers: { accept: 'application/octet-stream' } },
        expected.byteLength,
        'PUBLICATION_ARTIFACT_READBACK',
      );
      if (
        downloaded.response.status !== 200 ||
        downloaded.bytes.byteLength !== expected.byteLength ||
        !timingSafeEqual(downloaded.bytes, expected)
      )
        fail('PUBLICATION_ARTIFACT_MISMATCH');
    }
    return Object.freeze({
      ok: true,
      xformVersionId: versions[0],
      xlsformVersionId: versions[1],
      requestCount,
    });
  } catch (error) {
    const code =
      error instanceof ArtifactFailure
        ? error.code
        : 'PUBLICATION_ARTIFACT_READBACK';
    if (stored && !(await cleanup()))
      return refusal('PUBLICATION_ARTIFACT_CLEANUP', requestCount);
    return refusal(code, requestCount);
  }
}
