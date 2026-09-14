import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  assert.equal(call[2].windowsVerbatimArguments, false);
  assert.equal(call[2].env.SF_DISABLE_LOG_FILE, 'true');
  assert.equal(call[2].timeout, 30_000);
  assert.equal(call[2].killSignal, 'SIGKILL');
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
  assert.equal(call[2].windowsVerbatimArguments, true);
});

// The committed shim runs only this Node argument-capture fixture. It cannot
// discover or execute the installed Salesforce CLI. Do not spread process.env:
// real Salesforce auth, user profiles, NODE_OPTIONS and shell settings stay out.
function windowsFixture() {
  const cwd = fileURLToPath(
    new URL('./fixtures/windows-salesforce-client/', import.meta.url),
  );
  const shim = join(cwd, 'sf.cmd');
  const capture = join(cwd, 'capture-argv.mjs');
  assert.ok(statSync(shim).isFile());
  assert.ok(statSync(capture).isFile());
  assert.equal(
    readFileSync(shim, 'utf8').replaceAll('\r\n', '\n'),
    '@echo off\n@"%KUSANYA_TEST_NODE%" "%~dp0capture-argv.mjs" %*\n',
  );
  const systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot);
  assert.ok(statSync(join(systemRoot, 'System32', 'cmd.exe')).isFile());
  return {
    cwd,
    env: {
      SystemRoot: systemRoot,
      PATH: `${cwd};${join(systemRoot, 'System32')}`,
      PATHEXT: '.CMD',
      KUSANYA_TEST_NODE: process.execPath,
    },
  };
}
const windowsRuntime = {
  skip:
    process.platform !== 'win32' ? 'Requires the real Windows cmd.exe' : false,
};
test(
  'real Windows cmd and sf.cmd preserve synthetic arguments without outer escaped quotes',
  windowsRuntime,
  () => {
    const sf = createSalesforceClient(windowsFixture());
    const args = [
      'fixture-only',
      'data',
      'query',
      '--query',
      "SELECT Id FROM Synthetic__c WHERE (Name = 'fixture only' OR Name = 'other') AND CreatedDate = LAST_N_DAYS:1",
      '--path',
      'C:\\synthetic fixture\\nested directory\\file.json',
      '--directory',
      'C:/synthetic fixture/nested directory/',
      '--unicode',
      'Kusanya café 日本語',
    ];
    assert.deepEqual(sf('scratch-read', args).result.args, [...args, '--json']);
  },
);
test(
  'real Windows old spawn quoting is a failing negative control',
  windowsRuntime,
  () => {
    let launched;
    const sf = createSalesforceClient({
      ...windowsFixture(),
      spawn: (command, args, options) => {
        assert.equal(options.windowsVerbatimArguments, true);
        launched = spawnSync(command, args, {
          ...options,
          windowsVerbatimArguments: false,
        });
        return launched;
      },
    });
    assert.throws(
      () =>
        sf('scratch-read', ['fixture-only', 'synthetic argument with spaces']),
      SalesforceCommandError,
    );
    assert.ifError(launched.error);
    assert.notEqual(launched.status, 0);
  },
);
test(
  'real Windows fixture refuses shell syntax before execution and creates no injection marker',
  windowsRuntime,
  () => {
    const fixture = windowsFixture();
    const sf = createSalesforceClient(fixture);
    const marker = join(fixture.cwd, 'injection-must-not-exist.txt');
    assert.equal(existsSync(marker), false);
    for (const value of [
      'synthetic & echo injected > injection-must-not-exist.txt',
      'synthetic | echo injected > injection-must-not-exist.txt',
      'synthetic > injection-must-not-exist.txt',
      'synthetic < injection-must-not-exist.txt',
      'synthetic ^& echo injected',
      '%PATH%',
      '!PATH!',
      'synthetic"argument',
      'synthetic\nargument',
      'C:\\synthetic fixture\\',
      'C:\\synthetic fixture\\\\',
      'C:\\synthetic fixture\\\\\\',
    ]) {
      assert.throws(() => sf('scratch-read', ['fixture-only', value]), {
        code: 'INVALID_INPUT',
      });
      assert.equal(existsSync(marker), false);
    }
  },
);
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
    'C:\\fixture\\',
    'C:\\fixture\\\\',
    'C:\\fixture\\\\\\',
  ])
    assert.throws(() => windows('scratch-read', ['data', value]), {
      code: 'INVALID_INPUT',
    });
  const linux = createSalesforceClient({ cwd: '.', platform: 'linux', spawn });
  assert.throws(() => linux('scratch-read', ['x\ny']), {
    code: 'INVALID_INPUT',
  });
});
test('Linux preserves trailing backslashes as literal argv without a shell', () => {
  let actual;
  const sf = createSalesforceClient({
    cwd: '/fixture',
    env: {},
    platform: 'linux',
    spawn: (_command, args) => {
      actual = args;
      return { status: 0, stdout: '{"status":0,"result":[]}' };
    },
  });
  const args = ['fixture-only', 'C:\\fixture\\', 'C:\\fixture\\\\'];
  sf('scratch-read', args);
  assert.deepEqual(actual, [...args, '--json']);
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
    command('RemoteOrgSignupFailed', 'scratch-create').code,
    'CREATION_REJECTED',
  );
  assert.equal(
    command('RemoteOrgSignupFailed', 'scratch-create').retryable,
    false,
  );
  assert.equal(
    command('RemoteOrgSignupFailed', 'source-deploy').code,
    'CLI_FAILED',
  );
  assert.equal(
    command('signupFailedUnknown', 'scratch-create').code,
    'CLI_FAILED',
  );
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
test('all CLI operations have bounded hard-kill timeouts', () => {
  for (const stage of [
    'quota-read',
    'scratch-read',
    'scratch-cleanup',
    'scratch-create',
    'source-deploy',
    'apex-tests',
  ]) {
    let config;
    const sf = createSalesforceClient({
      cwd: '.',
      platform: 'linux',
      spawn: (_command, _args, options) => {
        config = options;
        return {
          status: null,
          error: { code: 'ETIMEDOUT', message: secret },
          // A killed process may leave buffered output; it cannot prove a
          // confirmed rejection or override the process-level timeout.
          stdout: JSON.stringify({ status: 1, name: 'RemoteOrgSignupFailed' }),
        };
      },
    });
    assert.throws(
      () => sf(stage, ['fixture']),
      (error) => {
        assert.equal(error.code, 'TIMEOUT');
        assert.ok(!error.message.includes(secret));
        return true;
      },
    );
    assert.equal(
      config.timeout,
      ['scratch-create', 'source-deploy', 'apex-tests'].includes(stage)
        ? 360_000
        : 30_000,
    );
    assert.equal(config.killSignal, 'SIGKILL');
  }
});
