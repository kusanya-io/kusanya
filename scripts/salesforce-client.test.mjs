import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSalesforceClient,
  SalesforceCommandError,
} from './salesforce-client.mjs';

const secret = 'fixture-only-sensitive-auth-token@example.invalid';
test('client preserves quoted SOQL as one Linux argument without a shell', () => {
  let call;
  const sf = createSalesforceClient({
    cwd: '/fixture',
    env: {},
    platform: 'linux',
    spawn: (...args) => {
      call = args;
      return {
        status: 0,
        stdout: JSON.stringify({ status: 0, result: { done: true } }),
      };
    },
  });
  const soql =
    "SELECT Id FROM ScratchOrgInfo WHERE OrgName = 'kusanya-ci-v1__run__abc'";
  assert.equal(
    sf('scratch-read', ['data', 'query', '--query', soql]).result.done,
    true,
  );
  assert.deepEqual(call[1], ['data', 'query', '--query', soql, '--json']);
  assert.equal(call[0], 'sf');
  assert.equal(call[2].shell, false);
  assert.equal(call[2].env.SF_DISABLE_LOG_FILE, 'true');
});
test('Windows command quotes safe SOQL including spaces, single quotes and colons', () => {
  let call;
  const sf = createSalesforceClient({
    cwd: 'C:/fixture',
    env: {},
    platform: 'win32',
    spawn: (...args) => {
      call = args;
      return { status: 0, stdout: '{"status":0,"result":[]}' };
    },
  });
  const query =
    "SELECT Id FROM ScratchOrgInfo WHERE CreatedDate = LAST_N_DAYS:1 AND OrgName = 'kusanya-builder-v1'";
  sf('scratch-read', ['data', 'query', '--query', query]);
  assert.equal(call[0], 'cmd.exe');
  assert.deepEqual(call[1].slice(0, 3), ['/d', '/s', '/c']);
  assert.ok(call[1][3].includes(`"${query}"`));
  assert.equal(call[2].shell, false);
});
test('Windows rejects expansion/metacharacters and all platforms reject controls', () => {
  const spawn = () => assert.fail('No unsafe input may start a process');
  const windows = createSalesforceClient({
    cwd: '.',
    platform: 'win32',
    spawn,
  });
  for (const value of [
    'x"y',
    '%PATH%',
    '!VAR!',
    'x&y',
    'x|y',
    'x>y',
    'x<y',
    'x^y',
    'x\ny',
    'x\0y',
  ])
    assert.throws(() => windows('scratch-read', ['data', value]), {
      code: 'INVALID_INPUT',
    });
  const linux = createSalesforceClient({ cwd: '.', platform: 'linux', spawn });
  assert.throws(() => linux('scratch-read', ['x\ny']), {
    code: 'INVALID_INPUT',
  });
});
test('raw stdout, stderr, exception and provider messages are never exposed', () => {
  for (const spawn of [
    () => ({ status: 1, stdout: secret, stderr: secret }),
    () => {
      throw new Error(secret);
    },
    () => ({
      status: 1,
      stdout: JSON.stringify({
        status: 1,
        name: 'UnknownProviderFailure',
        message: secret,
        stack: secret,
      }),
    }),
    () => ({ status: 0, stdout: '{"status":0}' }),
  ]) {
    const sf = createSalesforceClient({ cwd: '.', platform: 'linux', spawn });
    assert.throws(
      () => sf(secret, ['org', 'list']),
      (error) =>
        error instanceof SalesforceCommandError &&
        !error.message.includes(secret) &&
        !error.stack.includes(secret) &&
        error.retryable === false,
    );
  }
});
test('only allowlisted transient setup errors are retryable; tests and auth are not', () => {
  const command = (name, stage, message = secret) => {
    const sf = createSalesforceClient({
      cwd: '.',
      platform: 'linux',
      spawn: () => ({
        status: 1,
        stdout: JSON.stringify({
          status: 1,
          name,
          message,
          data: { jobId: '2SR000000000001' },
        }),
      }),
    });
    try {
      sf(stage, ['org', 'list']);
    } catch (error) {
      return error;
    }
    assert.fail('Expected sanitized failure');
  };
  assert.equal(command('ECONNRESET', 'scratch-create').retryable, true);
  assert.equal(command('ECONNRESET', 'apex-tests').retryable, false);
  assert.equal(command('invalid_grant', 'scratch-create').retryable, false);
  assert.equal(command('UnknownFailure', 'source-deploy').retryable, false);
  assert.equal(
    command('ScratchOrgInfoTimeoutError', 'scratch-create').jobId,
    '2SR000000000001',
  );
  assert.equal(
    command('ScratchOrgResumeTimeOutError', 'scratch-create').code,
    'TIMEOUT',
  );
  assert.equal(
    command(
      'REQUEST_LIMIT_EXCEEDED',
      'scratch-create',
      'Cannot create more than 3 active scratch orgs.',
    ).exitCode,
    75,
  );
  assert.equal(
    command(
      'REQUEST_LIMIT_EXCEEDED',
      'scratch-create',
      'API requests exceeded.',
    ).retryable,
    false,
  );
  assert.equal(
    command('ScratchOrgLimitExceeded', 'scratch-create').retryable,
    false,
  );
});
