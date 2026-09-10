import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireScratchOrgs,
  cleanupOwnedOrgs,
  preflight,
  runJanitor,
  QuotaBlockedError,
} from './scratch-lifecycle.mjs';
import { SalesforceCommandError } from './salesforce-client.mjs';
import { runVerification } from './verify-salesforce.mjs';

const now = new Date('2026-09-10T16:00:00.000Z');
const sha = 'a'.repeat(40);
const hub = 'fixture-dev-hub';
const identity = { devHub: hub, role: 'ci', runId: '100-1', sha, now };
const id = (prefix, number) => `${prefix}${String(number).padStart(12, '0')}`;
const tag = (role = 'ci', runId = '100-1', nonce = '000000000001') =>
  `kusanya-${role}-v1__${runId}__${sha.slice(0, 12)}__${nonce}`;
const envelope = (result) => ({ status: 0, result });
const record = (number, name = tag()) => ({
  Id: id('2SR', number),
  OrgName: name,
  Status: 'Active',
  ScratchOrg: id('00D', number),
  SignupUsername: `private-${number}@example.invalid`,
  CreatedDate: '2026-09-10T12:00:00.000Z',
});
const goodCoverage = envelope({
  summary: {
    outcome: 'Passed',
    testsRan: 1,
    passing: 1,
    failing: 0,
    skipped: 0,
  },
  tests: [{ Outcome: 'Pass' }],
  coverage: {
    coverage: [{ name: 'FixtureRuntime', totalCovered: 1, totalLines: 1 }],
  },
});

function fixture(options = {}) {
  const state = {
    records: structuredClone(options.records ?? []),
    calls: [],
    creates: 0,
    deletes: [],
    active: options.active ?? 3,
    daily: options.daily ?? 6,
    malformed: options.malformed ?? false,
  };
  const sf = (stage, args) => {
    state.calls.push({ stage, args });
    const value = (flag) => args[args.indexOf(flag) + 1];
    if (stage === 'hub-discovery')
      return envelope({ nonScratchOrgs: [{ alias: hub, isDevHub: true }] });
    if (stage === 'quota-read')
      return envelope(
        options.limits ?? [
          { name: 'ActiveScratchOrgs', max: 3, remaining: state.active },
          { name: 'DailyScratchOrgs', max: 6, remaining: state.daily },
        ],
      );
    if (stage === 'scratch-read') {
      const query = value('--query');
      let rows;
      if (query.includes('FROM ActiveScratchOrg')) {
        const orgId = /ScratchOrg = '([^']+)'/.exec(query)?.[1];
        rows = state.records
          .filter((row) => row.ScratchOrg === orgId && row.Status === 'Active')
          .map((row) => ({
            Id: row.Id.replace('2SR', '2AS'),
            ScratchOrg: row.ScratchOrg,
          }));
      } else if (query.includes('LAST_N_DAYS:1')) rows = state.records;
      else if (query.includes("WHERE Status = 'Active'"))
        rows = state.records.filter((row) => row.Status === 'Active');
      else if (query.includes('WHERE Id ='))
        rows = state.records.filter(
          (row) => row.Id === /WHERE Id = '([^']+)'/.exec(query)?.[1],
        );
      else
        rows = state.records.filter(
          (row) => row.OrgName === /OrgName = '([^']+)'/.exec(query)?.[1],
        );
      return envelope({
        done: !state.malformed,
        totalSize: rows.length,
        records: structuredClone(rows),
      });
    }
    if (stage === 'scratch-create') {
      state.creates += 1;
      const number = state.creates;
      const failing = options.failAt === number;
      if (failing && options.failure === 'quota') {
        state.daily = 0;
        throw new SalesforceCommandError('SCRATCH_QUOTA', stage);
      }
      const row = record(number, value('--name'));
      row.CreatedDate = options.createdAt ?? now.toISOString();
      if (failing && options.failure === 'pending') row.Status = 'New';
      if (failing && options.failure === 'error') row.Status = 'Error';
      if (!(failing && options.failure === 'absent')) state.records.push(row);
      state.daily -= 1;
      if (row.Status === 'Active') state.active -= 1;
      if (failing)
        throw new SalesforceCommandError(
          'TIMEOUT',
          stage,
          options.jobId ? row.Id : undefined,
        );
      return envelope({ orgId: row.ScratchOrg, username: row.SignupUsername });
    }
    if (stage === 'scratch-cleanup') {
      if (options.deleteFails)
        throw new Error('fixture-only-private-cleanup-details');
      const target = value('--record-id');
      const row = state.records.find(
        (entry) => entry.Id.replace('2SR', '2AS') === target,
      );
      assert.ok(row, 'A deletion must match an active owned fixture record');
      row.Status = 'Deleted';
      state.deletes.push(target);
      state.active += 1;
      return envelope({ id: target, success: true, errors: [] });
    }
    if (stage === 'source-deploy') {
      if (options.deployError) throw options.deployError;
      return envelope({ status: 'Succeeded' });
    }
    if (stage === 'apex-tests') {
      if (options.testError) throw options.testError;
      return options.coverage ?? goodCoverage;
    }
    assert.fail(`Unexpected fixture stage: ${stage}`);
  };
  return { sf, state };
}

function options(extra = {}) {
  let next = 0;
  return {
    ...identity,
    currentTime: () => now,
    nonce: () => String(++next).padStart(12, '0'),
    ...extra,
  };
}

function verify(f, extra = {}) {
  const output = [];
  const outcome = runVerification({
    env: {
      KUSANYA_DEV_HUB: hub,
      KUSANYA_VERIFY_ROLE: 'ci',
      KUSANYA_RUN_ID: '100-1',
      KUSANYA_HEAD_SHA: sha,
    },
    sf: f.sf,
    now,
    nonce: () => '000000000001',
    sourceNames: () => ['FixtureRuntime'],
    log: (line) => output.push(line),
    errorLog: (line) => output.push(line),
    ...extra,
  });
  const markers = output.filter((line) =>
    line.startsWith('KUSANYA_VERIFICATION_RESULT '),
  );
  assert.equal(markers.length, 1);
  assert.deepEqual(
    JSON.parse(markers[0].slice('KUSANYA_VERIFICATION_RESULT '.length)),
    outcome.result,
  );
  assert.ok(!output.join('\n').includes('@example.invalid'));
  assert.ok(!output.join('\n').includes('fixture-only-private'));
  return { ...outcome, output };
}

test('preflight permits capacity without creating or deleting an org', () => {
  const f = fixture();
  assert.deepEqual(preflight(f.sf, { devHub: hub, needed: 2, now }), {
    active: { max: 3, remaining: 3 },
    daily: { max: 6, remaining: 6 },
    needed: 2,
    nextSlotUtc: null,
  });
  assert.equal(f.state.creates, 0);
  assert.equal(f.state.deletes.length, 0);
});
test('daily shortage reports rolling next slot only with complete observed history', () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({
    ...record(index + 1),
    Status: 'Deleted',
    CreatedDate: `2026-09-10T${String(10 + index).padStart(2, '0')}:00:00.000Z`,
  }));
  const f = fixture({ daily: 0, records: rows });
  assert.throws(
    () => preflight(f.sf, { devHub: hub, needed: 2, now }),
    (error) =>
      error instanceof QuotaBlockedError &&
      error.exitCode === 75 &&
      error.report.nextSlotUtc === '2026-09-11T11:00:00.000Z' &&
      error.message.includes('daily 0/6'),
  );
  const unknown = fixture({ daily: 0 });
  assert.throws(
    () => preflight(unknown.sf, { devHub: hub, now }),
    (error) =>
      error.report.nextSlotUtc === null &&
      error.message.includes('unavailable'),
  );
});
test('active capacity and pair preflight fail before any creation', () => {
  const f = fixture({ active: 1 });
  assert.throws(
    () => acquireScratchOrgs(f.sf, options({ count: 2 })),
    (error) => error.exitCode === 75 && error.report.nextSlotUtc === null,
  );
  assert.equal(f.state.creates, 0);
});
test('malformed, duplicate, negative limits and incomplete/timestamp-invalid queries fail closed', () => {
  for (const limits of [
    {},
    [],
    [{ name: 'ActiveScratchOrgs', max: 3, remaining: -1 }],
    [
      { name: 'ActiveScratchOrgs', max: 3, remaining: 3 },
      { name: 'ActiveScratchOrgs', max: 3, remaining: 3 },
      { name: 'DailyScratchOrgs', max: 6, remaining: 6 },
    ],
  ]) {
    const f = fixture({ limits });
    assert.throws(() => acquireScratchOrgs(f.sf, options()), {
      code: 'INVALID_QUOTA',
    });
    assert.equal(f.state.creates, 0);
  }
  for (const f of [
    fixture({ malformed: true }),
    fixture({ records: [{ ...record(1), CreatedDate: 'not-a-date' }] }),
    fixture({ records: [{ ...record(1), CreatedDate: '5' }] }),
    fixture({ records: [record(1), record(1)] }),
    fixture({ records: [{ ...record(1), Status: 'Unknown' }] }),
  ]) {
    assert.throws(() => acquireScratchOrgs(f.sf, options()), {
      code: 'INVALID_QUERY',
    });
    assert.equal(f.state.creates, 0);
  }
});
test('one fresh tagged org is acquired, and cleanup matches remote IDs before deleting', () => {
  const f = fixture();
  const acquired = acquireScratchOrgs(f.sf, options());
  assert.equal(acquired.orgs.length, 1);
  assert.equal(acquired.orgs[0].tag, tag());
  assert.equal(f.state.creates, 1);
  assert.deepEqual(cleanupOwnedOrgs(f.sf, acquired.orgs), {
    deleted: 1,
    alreadyDeleted: 0,
  });
  assert.deepEqual(cleanupOwnedOrgs(f.sf, acquired.orgs), {
    deleted: 0,
    alreadyDeleted: 1,
  });
});
test('pair success creates exactly two; second failure cleans the first atomically', () => {
  const success = fixture();
  const pair = acquireScratchOrgs(success.sf, options({ count: 2 }));
  assert.equal(pair.orgs.length, 2);
  assert.equal(cleanupOwnedOrgs(success.sf, pair.orgs).deleted, 2);
  const failure = fixture({ failAt: 2, failure: 'error' });
  assert.throws(() => acquireScratchOrgs(failure.sf, options({ count: 2 })), {
    code: 'TIMEOUT',
  });
  assert.equal(failure.state.creates, 2);
  assert.deepEqual(failure.state.deletes, [id('2AS', 1)]);
});
test('timeout reconciles exact job ID or tag, deletes only owned created org, never retries creation', () => {
  for (const jobId of [true, false]) {
    const f = fixture({ failAt: 1, failure: 'active', jobId });
    assert.throws(() => acquireScratchOrgs(f.sf, options()), {
      code: 'TIMEOUT',
    });
    assert.equal(f.state.creates, 1);
    assert.deepEqual(f.state.deletes, [id('2AS', 1)]);
    if (jobId)
      assert.ok(
        f.state.calls.some(({ args }) =>
          args.some((value) => value.includes(`WHERE Id = '${id('2SR', 1)}'`)),
        ),
      );
  }
});
test('pending/unknown creation reconciliation is nonretryable and cannot delete an unproven org', () => {
  for (const failure of ['pending', 'absent']) {
    const f = fixture({ failAt: 1, failure });
    const outcome = verify(f);
    assert.equal(outcome.result.outcome, 'failed-cleanup');
    assert.equal(outcome.result.retryable, false);
    assert.equal(f.state.creates, 1);
    assert.equal(f.state.deletes.length, 0);
  }
});
test('quota creation race reports blocked75 and cleans an already acquired first org', () => {
  const f = fixture({
    failAt: 2,
    failure: 'quota',
    createdAt: '2026-09-10T16:01:00.000Z',
  });
  assert.throws(
    () =>
      acquireScratchOrgs(
        f.sf,
        options({
          count: 2,
          currentTime: () => new Date('2026-09-10T16:02:00.000Z'),
        }),
      ),
    { exitCode: 75 },
  );
  assert.equal(f.state.creates, 2);
  assert.deepEqual(f.state.deletes, [id('2AS', 1)]);
});
test('cleanup errors supersede acquisition errors and do not broaden deletion', () => {
  const f = fixture({ failAt: 2, failure: 'error', deleteFails: true });
  assert.throws(() => acquireScratchOrgs(f.sf, options({ count: 2 })), {
    code: 'CLEANUP_FAILED',
    retryable: false,
  });
  assert.equal(
    f.state.calls.filter(({ stage }) => stage === 'scratch-cleanup').length,
    1,
  );
});
test('role, run, SHA, source adoption and existing-target inputs fail closed', () => {
  for (const extra of [
    { role: 'builder' },
    { runId: '../bad' },
    { sha: 'abc' },
    { targetOrg: 'existing' },
    { existingOrg: 'existing' },
    { count: 3 },
  ]) {
    const f = fixture();
    assert.throws(() => acquireScratchOrgs(f.sf, options(extra)), {
      code: 'INVALID_INPUT',
    });
    assert.equal(f.state.creates, 0);
  }
  const existing = fixture({ records: [record(1)] });
  assert.throws(() => acquireScratchOrgs(existing.sf, options()), {
    code: 'OWNERSHIP_MISMATCH',
  });
  assert.equal(existing.state.creates, 0);
  assert.equal(existing.state.deletes.length, 0);
});
test('cleanup refuses changed role/name/org ownership', () => {
  for (const mutate of [
    (receipt) => {
      receipt.role = 'verifier';
    },
    (_, row) => {
      row.OrgName = 'another-run';
    },
    (_, row) => {
      row.ScratchOrg = id('00D', 9);
    },
  ]) {
    const f = fixture();
    const { orgs } = acquireScratchOrgs(f.sf, options());
    mutate(orgs[0], f.state.records[0]);
    assert.throws(() => cleanupOwnedOrgs(f.sf, orgs), {
      code: 'CLEANUP_FAILED',
    });
    assert.equal(f.state.deletes.length, 0);
  }
});
test('janitor defaults dry-run and applies only same-role, ended, exact-head run evidence', () => {
  const f = fixture({
    records: [
      record(1),
      record(2, tag('verifier', '200-1')),
      record(3, tag('ci', '300-1')),
      record(4, 'kusanya-builder-v1'),
    ],
  });
  const getRunStatus = ({ runId }) => ({
    status: runId === '100-1' ? 'completed' : 'in_progress',
    runId,
    headSha: sha,
  });
  assert.deepEqual(
    runJanitor(f.sf, { devHub: hub, role: 'ci', getRunStatus }).eligibleTags,
    [tag()],
  );
  assert.equal(f.state.deletes.length, 0);
  assert.equal(
    runJanitor(f.sf, { devHub: hub, role: 'ci', getRunStatus, apply: true })
      .deleted,
    1,
  );
  assert.equal(f.state.records[1].Status, 'Active');
  assert.equal(f.state.records[2].Status, 'Active');
  assert.equal(f.state.records[3].Status, 'Active');
});
test('janitor does not delete for missing, failed-read, mismatched run or mismatched SHA evidence', () => {
  for (const getRunStatus of [
    () => null,
    () => {
      throw new Error('offline');
    },
    () => ({ status: 'completed', runId: 'other', headSha: sha }),
    () => ({ status: 'completed', runId: '100-1', headSha: 'b'.repeat(40) }),
  ]) {
    const f = fixture({ records: [record(1)] });
    assert.equal(
      runJanitor(f.sf, { devHub: hub, role: 'ci', getRunStatus, apply: true })
        .deleted,
      0,
    );
    assert.equal(f.state.deletes.length, 0);
  }
});
test('wrapper emits exactly one successful full-head marker after tests and owned cleanup', () => {
  const f = fixture();
  const outcome = verify(f);
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(outcome.result, {
    schemaVersion: 1,
    role: 'ci',
    runId: '100-1',
    headSha: sha,
    outcome: 'passed',
    startedAt: now.toISOString(),
    retryable: false,
  });
  assert.equal(f.state.creates, 1);
  assert.equal(f.state.deletes.length, 1);
});
test('wrapper emits blocked quota75, test failures nonretryable and cleanup failure nonretryable', () => {
  const blocked = verify(fixture({ daily: 0 }));
  assert.equal(blocked.exitCode, 75);
  assert.equal(blocked.result.outcome, 'blocked-quota');
  assert.equal(blocked.result.retryable, true);
  for (const f of [
    fixture({ testError: new SalesforceCommandError('NETWORK', 'apex-tests') }),
    fixture({ coverage: envelope({}) }),
  ]) {
    const failed = verify(f);
    assert.equal(failed.result.outcome, 'failed-tests');
    assert.equal(failed.result.retryable, false);
    assert.equal(f.state.deletes.length, 1);
  }
  const cleanup = verify(fixture({ deleteFails: true }));
  assert.equal(cleanup.result.outcome, 'failed-cleanup');
  assert.equal(cleanup.result.retryable, false);
  assert.equal(cleanup.exitCode, 1);
});
test('wrapper distinguishes known transient infrastructure from unknown private errors', () => {
  const known = verify(
    fixture({
      deployError: new SalesforceCommandError('NETWORK', 'source-deploy'),
    }),
  );
  assert.equal(known.result.outcome, 'failed-infrastructure');
  assert.equal(known.result.retryable, true);
  const unknown = verify(
    fixture({ deployError: new Error('fixture-only-private-auth-token') }),
  );
  assert.equal(unknown.result.retryable, false);
});
test('wrapper rejects missing identity, command arguments and preexisting target inputs before org calls', () => {
  for (const extra of [
    { env: {} },
    { args: ['--target-org', 'existing'] },
    {
      env: {
        KUSANYA_DEV_HUB: hub,
        KUSANYA_VERIFY_ROLE: 'ci',
        KUSANYA_RUN_ID: '100-1',
        KUSANYA_HEAD_SHA: sha,
        SF_TARGET_ORG: 'existing',
      },
    },
  ]) {
    const f = fixture();
    const outcome = verify(f, extra);
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.result.retryable, false);
    assert.equal(f.state.calls.length, 0);
  }
});
