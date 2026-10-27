import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  administratorOidcActorId,
  AdministratorOidcError,
  createAdministratorOidcIdentity,
  verifyAdministratorOidcToken,
} from '../../src/tenant/oidc-login.js';

const configuration = {
  issuer: 'https://login.microsoftonline.com/tenant-id/v2.0',
  audience: '11111111-2222-3333-4444-555555555555',
  jwksUri: 'https://login.microsoftonline.com/tenant-id/discovery/v2.0/keys',
};

void test('one configured identity capability uses the same actor mapping for provisioning', () => {
  const identity = createAdministratorOidcIdentity(configuration);
  assert.equal(Object.isFrozen(identity), true);
  assert.equal(
    identity.actorIdForSubject('stable-subject'),
    administratorOidcActorId(configuration.issuer, 'stable-subject'),
  );
  for (const subject of ['', 'x'.repeat(513), 'line\nbreak'])
    assert.throws(
      () => identity.actorIdForSubject(subject),
      AdministratorOidcError,
    );
});

void test('OIDC verification binds a recent RS256 token to issuer plus subject', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'test-key';
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ sub: 'stable-subject' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })
    .setIssuer(configuration.issuer)
    .setAudience(configuration.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
  const verified = await verifyAdministratorOidcToken(
    token,
    configuration,
    createLocalJWKSet({ keys: [publicJwk] }),
  );
  assert.deepEqual(verified, {
    actorId: administratorOidcActorId(configuration.issuer, 'stable-subject'),
  });
  assert.match(verified.actorId, /^oidc:[A-Za-z0-9_-]{43}$/);
  assert.notEqual(
    verified.actorId,
    administratorOidcActorId(configuration.issuer, 'another-subject'),
  );
  assert.notEqual(
    verified.actorId,
    administratorOidcActorId(
      'https://login.microsoftonline.com/other-tenant/v2.0',
      'stable-subject',
    ),
  );
});

void test('OIDC verification refuses wrong boundaries with one fixed error', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'test-key';
  const key = createLocalJWKSet({ keys: [publicJwk] });
  const now = Math.floor(Date.now() / 1000);
  const signed = async (claims: Record<string, unknown>, issuedAt = now) =>
    await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(configuration.issuer)
      .setAudience(configuration.audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(now + 300)
      .sign(privateKey);
  const cases = [
    [await signed({}), configuration],
    [
      await new SignJWT({ sub: 'subject' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(configuration.issuer)
        .setAudience(configuration.audience)
        .setIssuedAt(now)
        .sign(privateKey),
      configuration,
    ],
    [await signed({ sub: 'subject' }, now - 600), configuration],
    [
      await signed({ sub: 'subject' }),
      { ...configuration, audience: 'wrong-audience' },
    ],
    [
      await signed({ sub: 'subject' }),
      { ...configuration, issuer: 'https://issuer.example/tenant' },
    ],
    [
      await signed({ sub: 'subject' }),
      { ...configuration, jwksUri: 'http://secret.example/keys' },
    ],
  ] as const;
  for (const [token, selectedConfiguration] of cases)
    await assert.rejects(
      verifyAdministratorOidcToken(token, selectedConfiguration, key),
      (error: unknown) =>
        error instanceof AdministratorOidcError &&
        error.message === 'ADMINISTRATOR_OIDC_AUTHENTICATION' &&
        !error.message.includes('secret'),
    );
});
