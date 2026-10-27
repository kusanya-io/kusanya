/** Standards-based OIDC identity verification for administrator session login. */
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

const tokenPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const audiencePattern = /^[\x21-\x7e]{1,512}$/;

export interface AdministratorOidcConfiguration {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUri: string;
}

export interface AdministratorOidcIdentity {
  readonly verifyLoginRequest: (
    request: FastifyRequest,
  ) => Promise<{ readonly actorId: string }>;
  readonly actorIdForSubject: (subject: string) => string;
}

export class AdministratorOidcError extends Error {
  constructor() {
    super('ADMINISTRATOR_OIDC_AUTHENTICATION');
    this.name = 'AdministratorOidcError';
  }
}

interface DecodedOidcConfiguration {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUri: URL;
}

function exactHttpsUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048)
    throw new AdministratorOidcError();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AdministratorOidcError();
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.href !== value
  )
    throw new AdministratorOidcError();
  return value;
}

function decodeConfiguration(
  configuration: AdministratorOidcConfiguration,
): DecodedOidcConfiguration {
  if (configuration === null || typeof configuration !== 'object')
    throw new AdministratorOidcError();
  const issuer = exactHttpsUrl(configuration.issuer);
  const jwksUri = new URL(exactHttpsUrl(configuration.jwksUri));
  if (
    typeof configuration.audience !== 'string' ||
    !audiencePattern.test(configuration.audience)
  )
    throw new AdministratorOidcError();
  return Object.freeze({
    issuer,
    audience: configuration.audience,
    jwksUri,
  });
}

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer '))
    throw new AdministratorOidcError();
  const token = header.slice(7);
  if (token.length < 16 || token.length > 16_384 || !tokenPattern.test(token))
    throw new AdministratorOidcError();
  return token;
}

function actorId(issuer: string, subject: unknown): string {
  const containsControlCharacter =
    typeof subject === 'string' &&
    Array.from(subject).some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    });
  if (
    typeof subject !== 'string' ||
    subject.length < 1 ||
    subject.length > 512 ||
    containsControlCharacter
  )
    throw new AdministratorOidcError();
  const digest = createHash('sha256')
    .update('kusanya:administrator-oidc-actor:v1\0', 'utf8')
    .update(issuer, 'utf8')
    .update('\0', 'utf8')
    .update(subject, 'utf8')
    .digest('base64url');
  return `oidc:${digest}`;
}

/** Verify one signed, recent API access token and return only its stable actor identity. */
export async function verifyAdministratorOidcToken(
  token: string,
  configuration: AdministratorOidcConfiguration,
  key: JWTVerifyGetKey,
): Promise<{ readonly actorId: string }> {
  try {
    const decoded = decodeConfiguration(configuration);
    const result = await jwtVerify(token, key, {
      algorithms: ['RS256'],
      issuer: decoded.issuer,
      audience: decoded.audience,
      requiredClaims: ['exp', 'iat', 'sub'],
      maxTokenAge: '5m',
      clockTolerance: 5,
    });
    return Object.freeze({
      actorId: actorId(decoded.issuer, result.payload.sub),
    });
  } catch {
    throw new AdministratorOidcError();
  }
}

/** Create the injected verifier consumed by the reviewed administrator login route. */
export function createAdministratorOidcIdentity(
  configuration: AdministratorOidcConfiguration,
): AdministratorOidcIdentity {
  const decoded = decodeConfiguration(configuration);
  const key = createRemoteJWKSet(decoded.jwksUri, {
    timeoutDuration: 3_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
  });
  return Object.freeze({
    verifyLoginRequest: async (request: FastifyRequest) =>
      await verifyAdministratorOidcToken(
        bearerToken(request),
        {
          issuer: decoded.issuer,
          audience: decoded.audience,
          jwksUri: decoded.jwksUri.href,
        },
        key,
      ),
    actorIdForSubject: (subject: string) => actorId(decoded.issuer, subject),
  });
}

/** Backwards-compatible verifier factory for adapters that need login only. */
export function createAdministratorOidcLoginVerifier(
  configuration: AdministratorOidcConfiguration,
): (request: FastifyRequest) => Promise<{ readonly actorId: string }> {
  return createAdministratorOidcIdentity(configuration).verifyLoginRequest;
}

/** Stable provisioning key for an already verified issuer/subject pair. */
export function administratorOidcActorId(
  issuer: string,
  subject: string,
): string {
  return actorId(exactHttpsUrl(issuer), subject);
}
