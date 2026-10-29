import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  administratorSessionCookieName,
  AdministratorSessionCookieError,
  isAdministratorSessionValue,
  parseAdministratorSessionSetCookie,
  serializeAdministratorSessionCookie,
} from '../../src/tenant/administrator-cookie.js';

const opaqueSession = 's'.repeat(43);

void test('one shared contract serializes and parses the hardened host cookie', () => {
  const serialized = serializeAdministratorSessionCookie(opaqueSession, 900);
  assert.equal(
    serialized,
    `${administratorSessionCookieName}=${opaqueSession}; Path=/; Max-Age=900; Secure; HttpOnly; SameSite=Lax`,
  );
  assert.deepEqual(parseAdministratorSessionSetCookie(serialized), {
    opaqueSession,
    maxAgeSeconds: 900,
  });
  assert.equal(
    serializeAdministratorSessionCookie('', 0),
    `${administratorSessionCookieName}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
  );
  assert.equal(isAdministratorSessionValue(opaqueSession), true);
  assert.equal(isAdministratorSessionValue(''), false);
});

void test('client parsing permits attribute order but never attribute drift', () => {
  assert.deepEqual(
    parseAdministratorSessionSetCookie(
      `${administratorSessionCookieName}=${opaqueSession}; HttpOnly; SameSite=Lax; Max-Age=3600; Path=/; Secure`,
    ),
    { opaqueSession, maxAgeSeconds: 3600 },
  );
  for (const value of [
    null,
    `${administratorSessionCookieName}=${opaqueSession}; Path=/; Max-Age=900; HttpOnly; SameSite=Lax`,
    `${administratorSessionCookieName}=${opaqueSession}; Path=/; Max-Age=900; Secure; HttpOnly; SameSite=None`,
    `${administratorSessionCookieName}=${opaqueSession}; Path=/; Max-Age=900; Secure; HttpOnly; SameSite=Lax; Domain=service.example`,
    `${administratorSessionCookieName}=${opaqueSession}; Path=/; Max-Age=59; Secure; HttpOnly; SameSite=Lax`,
    `${administratorSessionCookieName}=${opaqueSession}; Path=/; Max-Age=900; Secure; Secure; SameSite=Lax`,
    `other=${opaqueSession}; Path=/; Max-Age=900; Secure; HttpOnly; SameSite=Lax`,
    `${administratorSessionCookieName}=short; Path=/; Max-Age=900; Secure; HttpOnly; SameSite=Lax`,
  ])
    assert.throws(() => parseAdministratorSessionSetCookie(value), {
      name: 'AdministratorSessionCookieError',
      message: 'ADMINISTRATOR_SESSION_COOKIE',
    });
});

void test('server serialization refuses unsafe values and lifetimes', () => {
  for (const [value, maxAge] of [
    ['', 1],
    [opaqueSession, 0],
    [opaqueSession, 59],
    [opaqueSession, 86_401],
    ['short', 900],
    [opaqueSession, 1.5],
  ] as const)
    assert.throws(
      () => serializeAdministratorSessionCookie(value, maxAge),
      AdministratorSessionCookieError,
    );
});
