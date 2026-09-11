import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCleanupJournal,
  readCleanupJournal,
} from './scratch-cleanup-journal.mjs';
import { runCleanup } from './cleanup-salesforce.mjs';
import { runVerification } from './verify-salesforce.mjs';

const sha = 'a'.repeat(40);
const identity = { role: 'ci', runId: '500-1', sha, devHub: 'fixture-hub' };
const tag = `kusanya-ci-v1__500-1__${sha.slice(0, 12)}__012345abcdef`;
const id = (prefix) => `${prefix}000000000001`;
function setup(t) {
  const base = resolve(dirname(fileURLToPath(import.meta.url)), '../work');
  mkdirSync(base, { recursive: true });
  const temp = mkdtempSync(join(base, 'issue5-journal-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_RUN_ID: '500',
    GITHUB_RUN_ATTEMPT: '1',
    RUNNER_TEMP: temp,
    KUSANYA_CLEANUP_JOURNAL: join(temp, 'kusanya-scratch-intents.json'),
    KUSANYA_DEV_HUB: identity.devHub,
    KUSANYA_VERIFY_ROLE: identity.role,
    KUSANYA_RUN_ID: identity.runId,
    KUSANYA_HEAD_SHA: identity.sha,
  };
  return { env, temp };
}
function remote(status = 'Active') {
  const state = { status, deleted: 0, calls: [] };
  const sf = (stage, args) => {
    state.calls.push({ stage, args });
    if (stage === 'scratch-cleanup') {
      assert.equal(args.at(-1), id('2AS'));
      state.deleted += 1;
      state.status = 'Deleted';
      return { result: { success: true } };
    }
    assert.equal(stage, 'scratch-read');
    const query = args.at(-1);
    const records =
      state.status === 'absent'
        ? []
        : query.includes('FROM ActiveScratchOrg')
          ? [{ Id: id('2AS'), ScratchOrg: id('00D') }]
          : [
              {
                Id: id('2SR'),
                OrgName: tag,
                Status: state.status,
                ScratchOrg: state.status === 'Error' ? null : id('00D'),
                SignupUsername: 'private@example.invalid',
              },
            ];
    return { result: { done: true, totalSize: records.length, records } };
  };
  return { state, sf };
}
function cleanup(env, sf) {
  const logs = [];
  const result = runCleanup({
    env,
    sf,
    log: (line) => logs.push(line),
    errorLog: (line) => logs.push(line),
  });
  assert.ok(!logs.join('\n').includes('private@example.invalid'));
  return { ...result, logs };
}

test('journal records exact safe intent before creation and remains readable after interruption', (t) => {
  const { env } = setup(t);
  const journal = createCleanupJournal({ env, identity });
  journal.onIntent({ ...identity, tag });
  assert.deepEqual(readCleanupJournal({ env, identity }).tags, [tag]);
  assert.equal(
    readFileSync(env.KUSANYA_CLEANUP_JOURNAL, 'utf8').includes('username'),
    false,
  );
  // The verification process dies here; a separate invocation recovers its intent.
  const f = remote();
  assert.equal(cleanup(env, f.sf).exitCode, 0);
  assert.equal(f.state.deleted, 1);
  const again = cleanup(env, f.sf);
  assert.equal(again.exitCode, 0);
  assert.equal(again.result.alreadyDeleted, 1);
  assert.equal(f.state.deleted, 1);
});

test('known rejection differs from missing or pending timed-out creation', (t) => {
  const { env } = setup(t);
  const journal = createCleanupJournal({ env, identity });
  journal.onIntent({ ...identity, tag });
  for (const status of ['absent', 'New', 'Creating']) {
    const f = remote(status);
    assert.equal(cleanup(env, f.sf).exitCode, 1);
    assert.equal(f.state.deleted, 0);
  }
  journal.onRejected({ ...identity, tag });
  const f = remote('absent');
  const result = cleanup(env, f.sf);
  assert.equal(result.exitCode, 0);
  assert.equal(result.result.rejected, 1);
  assert.equal(f.state.deleted, 0);
});

test('journal refuses previous-run files and off-run intents without replacing valid evidence', (t) => {
  const { env } = setup(t);
  const journal = createCleanupJournal({ env, identity });
  assert.throws(() => createCleanupJournal({ env, identity }));
  for (const receipt of [
    { ...identity, tag: tag.replace('500-1', '500-2') },
    { ...identity, tag: tag.replace('kusanya-ci', 'kusanya-verifier') },
    { ...identity, sha: 'b'.repeat(40), tag },
    { ...identity, devHub: 'different-hub', tag },
  ])
    assert.throws(() => journal.onIntent(receipt));
  assert.deepEqual(readCleanupJournal({ env, identity }).tags, []);
});

test('missing, corrupt, foreign, duplicate, unknown-field and oversized journals fail before remote calls', (t) => {
  const { env } = setup(t);
  const f = remote();
  assert.equal(cleanup(env, f.sf).exitCode, 1);
  const base = { schemaVersion: 1, ...identity, tags: [tag], rejectedTags: [] };
  for (const value of [
    'not-json',
    JSON.stringify({ ...base, sha: 'b'.repeat(40) }),
    JSON.stringify({ ...base, runId: '501-1' }),
    JSON.stringify({ ...base, tags: [tag, tag] }),
    JSON.stringify({ ...base, rejectedTags: ['foreign-tag'] }),
    JSON.stringify({ ...base, token: 'fixture-secret-not-printed' }),
    'x'.repeat(16385),
  ]) {
    writeFileSync(env.KUSANYA_CLEANUP_JOURNAL, value);
    assert.equal(cleanup(env, f.sf).exitCode, 1);
  }
  assert.equal(f.state.calls.length, 0);
});

test('fixed runner path, CI identity, no arguments and no existing target are required', (t) => {
  const { env, temp } = setup(t);
  createCleanupJournal({ env, identity });
  const f = remote();
  for (const extra of [
    { KUSANYA_CLEANUP_JOURNAL: join(temp, '..', 'outside.json') },
    { KUSANYA_CLEANUP_JOURNAL: 'relative.json' },
    { RUNNER_TEMP: '' },
    { KUSANYA_VERIFY_ROLE: 'verifier' },
    { GITHUB_ACTIONS: 'false' },
    { GITHUB_RUN_ID: '501' },
    { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_RUN_ATTEMPT: '' },
    { SF_TARGET_ORG: 'existing' },
  ])
    assert.equal(cleanup({ ...env, ...extra }, f.sf).exitCode, 1);
  assert.equal(
    runCleanup({
      env,
      args: ['--target-org', 'existing'],
      sf: f.sf,
      errorLog: () => {},
    }).exitCode,
    1,
  );
  assert.equal(f.state.calls.length, 0);
});

test('hosted verification cannot start without a usable exclusive cleanup journal', (t) => {
  const { env } = setup(t);
  createCleanupJournal({ env, identity });
  let calls = 0;
  const result = runVerification({
    env,
    sf: () => {
      calls += 1;
    },
    log: () => {},
    errorLog: () => {},
  });
  assert.equal(result.exitCode, 1);
  assert.equal(calls, 0);
  assert.throws(() =>
    createCleanupJournal({ env: { GITHUB_ACTIONS: 'true' }, identity }),
  );
  assert.equal(createCleanupJournal({ env: {}, identity }), null);
});

test('hosted harness persists before create and the separate finalizer is idempotent after success or test failure', (t) => {
  for (const testFails of [false, true]) {
    const { env } = setup(t);
    const f = remote('absent');
    const sf = (stage, args) => {
      if (stage === 'hub-discovery')
        return {
          result: {
            nonScratchOrgs: [{ alias: identity.devHub, isDevHub: true }],
          },
        };
      if (stage === 'quota-read')
        return {
          result: [
            { name: 'ActiveScratchOrgs', max: 3, remaining: 3 },
            { name: 'DailyScratchOrgs', max: 6, remaining: 6 },
          ],
        };
      if (stage === 'scratch-create') {
        assert.deepEqual(readCleanupJournal({ env, identity }).tags, [tag]);
        f.state.status = 'Active';
        return { result: {} };
      }
      if (stage === 'source-deploy' || stage === 'apex-tests') {
        assert.equal(args[args.indexOf('--wait') + 1], '5');
        if (stage === 'apex-tests' && testFails)
          throw new Error('private-fixture-test-error');
        return { result: {} };
      }
      return f.sf(stage, args);
    };
    const logs = [];
    const result = runVerification({
      env,
      sf,
      nonce: () => '012345abcdef',
      sourceNames: () => ['FixtureRuntime'],
      coverage: () => ({ tests: 1, covered: 2, total: 2, percentage: 100 }),
      log: (line) => logs.push(line),
      errorLog: (line) => logs.push(line),
    });
    assert.equal(result.exitCode, testFails ? 1 : 0);
    assert.equal(result.result.outcome, testFails ? 'failed-tests' : 'passed');
    assert.equal(f.state.deleted, 1);
    const finalizer = cleanup(env, f.sf);
    assert.equal(finalizer.exitCode, 0);
    assert.equal(finalizer.result.alreadyDeleted, 1);
    assert.equal(f.state.deleted, 1);
    assert.ok(!logs.join('\n').includes('private-fixture-test-error'));
  }
});
