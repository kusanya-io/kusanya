import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigurationError, readConfig } from '../../src/config.js';
const validEnvironment = {
  DATABASE_URL: 'postgresql://kusanya@localhost:5432/kusanya',
};
void test('configuration defaults are bounded, immutable, and use verified database TLS', () => {
  const config = readConfig(validEnvironment);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3000);
  assert.equal(config.databaseSsl, true);
  assert.equal(config.databasePoolMax, 10);
  assert.equal(config.databaseTimeoutMs, 3000);
  assert.ok(Object.isFrozen(config));
});
void test('development and test may explicitly disable database TLS', () => {
  for (const nodeEnv of ['development', 'test'])
    assert.equal(
      readConfig({
        ...validEnvironment,
        NODE_ENV: nodeEnv,
        DATABASE_SSL: 'false',
      }).databaseSsl,
      false,
    );
});
void test('production rejects disabled database TLS', () => {
  assert.throws(
    () =>
      readConfig({
        ...validEnvironment,
        NODE_ENV: 'production',
        DATABASE_SSL: 'false',
      }),
    /DATABASE_SSL/,
  );
});
void test('invalid configuration fails without reflecting its value', () => {
  for (const [name, value] of [
    ['DATABASE_URL', ''],
    ['DATABASE_URL', 'https://secret-value.example/secret-value'],
    ['DATABASE_URL', 'postgresql://localhost'],
    ['DATABASE_URL', 'postgresql://localhost/db?sslmode=disable'],
    ['DATABASE_URL', 'postgresql://localhost/db#secret-value'],
    ['PORT', '0'],
    ['PORT', '65536'],
    ['PORT', '3.14'],
    ['PORT', '3000secret-value'],
    ['DATABASE_POOL_MAX', '101'],
    ['DATABASE_TIMEOUT_MS', '30001'],
    ['DATABASE_TIMEOUT_MS', '-1'],
    ['DATABASE_SSL', 'secret-value'],
    ['NODE_ENV', 'secret-value'],
    ['LOG_LEVEL', 'secret-value'],
    ['HOST', ' '],
  ] as const)
    assert.throws(
      () => readConfig({ ...validEnvironment, [name]: value }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.ok(error.message.includes(name));
        assert.ok(!error.message.includes('secret-value'));
        return true;
      },
    );
  assert.throws(() => readConfig({}), /DATABASE_URL/);
});
