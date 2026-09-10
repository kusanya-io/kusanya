import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUILDER_MARKER,
  BuilderOrgError,
  builderAliasForHub,
  manageBuilderOrg,
  parseBuilderArgs,
  runBuilderCli,
} from './builder-org.mjs';

const HUB_ID = '00D000000000001AAA';
const ORG_ID = '00D000000000002AAA';
const JOB_ID = '2SR000000000001AAA';
const NONCE = '11111111-1111-4111-8111-111111111111';
const NEXT_NONCE = '22222222-2222-4222-8222-222222222222';
const HUB_USER = 'private-hub@example.invalid';
const BUILDER_USER = 'private-builder@example.invalid';
const PRIVATE_TEXT = 'private-auth-value-not-a-real-credential';
const clock = new Date('2026-09-10T12:00:00.000Z');
const env = { KUSANYA_DEV_HUB: 'LocalHub' };
const clone = (value) => structuredClone(value);
const goodReceipt = () => ({
  version: 1,
  marker: BUILDER_MARKER,
  hubId: HUB_ID.slice(0, 15),
  alias: builderAliasForHub(HUB_ID),
  tag: BUILDER_MARKER + ':' + NONCE,
  requestedAt: '2026-09-10T11:59:00.000Z',
  durationDays: 7,
  phase: 'active',
  jobId: JOB_ID,
  orgId: ORG_ID.slice(0, 15),
});
const goodRow = () => ({
  Id: JOB_ID,
  OrgName: BUILDER_MARKER,
  Description: BUILDER_MARKER + ':' + NONCE,
  Status: 'Active',
  ScratchOrg: ORG_ID,
  SignupUsername: BUILDER_USER,
  CreatedDate: '2026-09-10T12:00:00.000Z',
  ExpirationDate: '2026-09-17',
  DurationDays: 7,
});
const goodLocal = () => ({
  orgId: ORG_ID,
  username: BUILDER_USER,
  alias: builderAliasForHub(HUB_ID),
  devHubUsername: HUB_USER,
});

function fixture({ active = false } = {}) {
  const model = {
    state: active ? goodReceipt() : null,
    rows: active ? [goodRow()] : [],
    local: active ? [goodLocal()] : [],
    aliases: active
      ? [{ alias: builderAliasForHub(HUB_ID), value: BUILDER_USER }]
      : [],
    hub: {
      alias: 'LocalHub',
      username: HUB_USER,
      orgId: HUB_ID,
      isDevHub: true,
    },
    calls: [],
    quotaCalls: 0,
    locked: false,
  };
  const store = {
    withLock(_hub, fn) {
      if (model.locked)
        throw new BuilderOrgError('LOCKED', 'Builder lock already held.');
      model.locked = true;
      try {
        return fn();
      } finally {
        model.locked = false;
      }
    },
    load: () => clone(model.state),
    save: (_hub, state) => {
      model.state = clone(state);
    },
  };
  const sf = (stage, args) => {
    model.calls.push({ stage, args: [...args] });
    const command = args.slice(0, 3).join(' ');
    const get = (flag) => args[args.indexOf(flag) + 1];
    let result;
    if (command === 'org list --all')
      result = {
        nonScratchOrgs: [clone(model.hub)],
        scratchOrgs: clone(model.local),
      };
    else if (args[0] === 'alias' && args[1] === 'list')
      result = clone(model.aliases);
    else if (args[0] === 'alias' && args[1] === 'unset') {
      model.aliases = model.aliases.filter((entry) => entry.alias !== args[2]);
      result = {};
    } else if (args[0] === 'data' && args[1] === 'query') {
      assert.equal(get('--target-org'), HUB_USER);
      if (model.queryFailure) throw new Error(PRIVATE_TEXT);
      result = {
        done: true,
        totalSize: model.rows.length,
        records: clone(model.rows),
        ...model.queryOverrides,
      };
    } else if (command === 'org create scratch') {
      assert.equal(
        model.state.phase,
        'pending',
        'intent must be durable before creation',
      );
      assert.equal(get('--target-dev-hub'), HUB_USER);
      assert.equal(get('--name'), BUILDER_MARKER);
      assert.ok(args.includes('--async'));
      assert.ok(!args.includes('--set-default'));
      const requestId = model.rows.some((row) => row.Id === JOB_ID)
        ? '2SR000000000002AAA'
        : JOB_ID;
      const row = {
        ...goodRow(),
        Id: requestId,
        Description: get('--description'),
        DurationDays: Number(get('--duration-days')),
        ExpirationDate: new Date(
          clock.getTime() + Number(get('--duration-days')) * 86400000,
        )
          .toISOString()
          .slice(0, 10),
        Status: 'Creating',
        ScratchOrg: null,
        SignupUsername: null,
      };
      if (!model.hideCreate) model.rows.push(row);
      if (model.createFailure)
        throw Object.assign(new Error(PRIVATE_TEXT), model.createFailure);
      result = { jobId: requestId };
    } else if (command === 'org resume scratch') {
      assert.equal(get('--job-id'), model.state.jobId);
      assert.ok(!args.includes('--use-most-recent'));
      if (model.resumeFailure) throw new Error(PRIVATE_TEXT);
      const row = model.rows.find((entry) => entry.Id === get('--job-id'));
      assert.ok(row);
      Object.assign(row, {
        Status: 'Active',
        ScratchOrg: ORG_ID,
        SignupUsername: BUILDER_USER,
      });
      model.local = [goodLocal()];
      model.aliases = [{ alias: model.state.alias, value: BUILDER_USER }];
      result = { orgId: ORG_ID, username: BUILDER_USER };
    } else if (command === 'org delete scratch') {
      assert.equal(
        get('--target-org'),
        BUILDER_USER,
        'delete the checked identity, never a mutable alias',
      );
      assert.ok(args.includes('--no-prompt'));
      for (const row of model.rows)
        if (row.SignupUsername === BUILDER_USER) row.Status = 'Deleted';
      model.local = [];
      model.aliases = [];
      result = {};
    } else assert.fail('Unexpected synthetic Salesforce operation.');
    return { status: 0, result };
  };
  const options = {
    env,
    sf,
    store,
    now: () => new Date(clock),
    newId: () => NEXT_NONCE,
    checkQuota: (_sf, quota) => {
      assert.equal(quota.needed, 1);
      assert.equal(quota.devHub, HUB_USER);
      model.quotaCalls += 1;
      if (model.quotaFailure) throw model.quotaFailure;
      return {};
    },
  };
  return {
    model,
    options,
    run: (command, extra = {}) =>
      manageBuilderOrg({ ...options, command, ...extra }),
  };
}
const operations = (model, command) =>
  model.calls.filter((call) => call.args.slice(0, 3).join(' ') === command);
function noOrgMutations(model) {
  assert.equal(operations(model, 'org create scratch').length, 0);
  assert.equal(operations(model, 'org delete scratch').length, 0);
  assert.equal(operations(model, 'org resume scratch').length, 0);
}

test('builder CLI accepts only the three local commands and bounded acquisition duration', () => {
  assert.deepEqual(parseBuilderArgs(['acquire', '--days', '1']), {
    command: 'acquire',
    days: 1,
  });
  assert.deepEqual(parseBuilderArgs(['status']), {
    command: 'status',
    days: 7,
  });
  for (const args of [
    [],
    ['verify'],
    ['release', '--target-org', 'anything'],
    ['acquire', '--days', '8'],
    ['acquire', '--days', '0'],
    ['acquire', '--days', '1;echo'],
    ['acquire', '--days', '1', '--days', '2'],
  ])
    assert.throws(() => parseBuilderArgs(args), BuilderOrgError);
});
test('CI presence, authentication URL input, username input and CI aliases are rejected before discovery', () => {
  for (const bad of [
    {},
    { KUSANYA_DEV_HUB: HUB_USER },
    { KUSANYA_DEV_HUB: 'LocalHub;unsafe' },
    { KUSANYA_DEV_HUB: 'Kusanya-CI-DevHub' },
    { ...env, CI: '' },
    { ...env, CI: 'false' },
    { ...env, GITHUB_ACTIONS: undefined },
    { ...env, SF_DEV_HUB_AUTH_URL: PRIVATE_TEXT },
    { ...env, sf_dev_hub_auth_url: '' },
    Object.assign(Object.create({ CI: 'true' }), env),
  ]) {
    const f = fixture();
    assert.throws(() => f.run('acquire', { env: bad }), BuilderOrgError);
    assert.equal(f.model.calls.length, 0);
  }
});
test('invalid duration and command inputs never call Salesforce', () => {
  for (const days of [0, 8, 1.5, NaN, '7']) {
    const f = fixture();
    assert.throws(() => f.run('acquire', { days }), BuilderOrgError);
    assert.equal(f.model.calls.length, 0);
  }
  const f = fixture();
  assert.throws(() => f.run('deploy'), BuilderOrgError);
  assert.equal(f.model.calls.length, 0);
});
test('acquire persists one tagged request, resumes it, and subsequently reuses without quota or another create', () => {
  const f = fixture();
  assert.equal(f.run('acquire', { days: 3 }).status, 'available');
  assert.equal(f.model.state.durationDays, 3);
  assert.equal(f.model.state.phase, 'active');
  assert.equal(f.model.quotaCalls, 1);
  assert.equal(f.run('acquire').status, 'available');
  assert.equal(f.run('status').status, 'available');
  assert.equal(operations(f.model, 'org create scratch').length, 1);
  assert.equal(operations(f.model, 'org resume scratch').length, 1);
  assert.equal(f.model.quotaCalls, 1);
  assert.doesNotMatch(
    JSON.stringify(f.model.state),
    /@|private-auth|username|accessToken|refreshToken/,
  );
});
test('release deletes only the exact positively checked identity and records release', () => {
  const f = fixture({ active: true });
  assert.equal(f.run('release').status, 'released');
  assert.equal(operations(f.model, 'org delete scratch').length, 1);
  assert.equal(f.model.state.phase, 'released');
  assert.equal(f.model.quotaCalls, 0);
});
test('spoofed markers, receipt mismatch, foreign hub association and alias rebinding fail closed', () => {
  for (const corrupt of [
    (m) => {
      m.state = null;
    },
    (m) => {
      m.rows[0].OrgName = BUILDER_MARKER + '-spoof';
    },
    (m) => {
      m.rows[0].Description = BUILDER_MARKER + ':' + NEXT_NONCE;
    },
    (m) => {
      m.state.marker = 'foreign';
    },
    (m) => {
      m.state.hubId = '00D000000000099';
    },
    (m) => {
      m.state.alias = 'foreign-alias';
    },
    (m) => {
      m.local[0].devHubUsername = 'foreign-hub@example.invalid';
    },
    (m) => {
      m.local[0].orgId = '00D000000000099AAA';
    },
    (m) => {
      m.aliases[0].value = 'foreign-org@example.invalid';
    },
    (m) => {
      m.hub.isDevHub = false;
    },
  ]) {
    for (const command of ['acquire', 'release']) {
      const f = fixture({ active: true });
      corrupt(f.model);
      assert.throws(() => f.run(command), BuilderOrgError);
      noOrgMutations(f.model);
    }
  }
});
test('duplicate marked orgs and incomplete ownership query results block all mutations', () => {
  for (const corrupt of [
    (m) => {
      m.rows.push({
        ...goodRow(),
        Id: '2SR000000000002AAA',
        ScratchOrg: '00D000000000003AAA',
        Description: BUILDER_MARKER + ':' + NEXT_NONCE,
      });
    },
    (m) => {
      m.queryOverrides = { done: false };
    },
    (m) => {
      m.queryOverrides = { totalSize: 2 };
    },
  ]) {
    const f = fixture({ active: true });
    corrupt(f.model);
    assert.throws(() => f.run('acquire'), BuilderOrgError);
    noOrgMutations(f.model);
  }
});
test('unbounded, inconsistent or invalid expiry prevents reuse and deletion', () => {
  for (const corrupt of [
    (m) => {
      m.rows[0].DurationDays = 8;
    },
    (m) => {
      m.rows[0].ExpirationDate = '2026-10-01';
    },
    (m) => {
      m.rows[0].ExpirationDate = 'not-a-date';
    },
    (m) => {
      m.rows[0].CreatedDate = 'not-a-date';
    },
    (m) => {
      m.rows[0].CreatedDate = '2027-01-01T12:00:00.000Z';
      m.rows[0].ExpirationDate = '2027-01-08';
    },
    (m) => {
      m.state.durationDays = 30;
    },
  ]) {
    const f = fixture({ active: true });
    corrupt(f.model);
    assert.throws(() => f.run('release'), BuilderOrgError);
    noOrgMutations(f.model);
  }
});

function expire(model) {
  model.state.requestedAt = '2026-09-01T11:59:00.000Z';
  model.rows[0].CreatedDate = '2026-09-01T12:00:00.000Z';
  model.rows[0].ExpirationDate = '2026-09-08';
}
test('expired receipt never deletes a rebound alias and acquire refuses foreign alias cleanup', () => {
  const f = fixture({ active: true });
  expire(f.model);
  f.model.aliases[0].value = 'foreign-org@example.invalid';
  assert.equal(f.run('status').status, 'expired');
  assert.equal(f.run('release').status, 'expired');
  noOrgMutations(f.model);
  assert.throws(() => f.run('acquire'), BuilderOrgError);
  assert.equal(
    f.model.calls.filter(
      (call) => call.args[0] === 'alias' && call.args[1] === 'unset',
    ).length,
    0,
  );
  noOrgMutations(f.model);
});
test('an exactly owned expired org permits a new explicit acquire without deleting any org', () => {
  const f = fixture({ active: true });
  expire(f.model);
  assert.equal(f.run('acquire').status, 'available');
  assert.equal(operations(f.model, 'org create scratch').length, 1);
  assert.equal(operations(f.model, 'org delete scratch').length, 0);
  assert.equal(
    f.model.rows.filter(
      (row) => row.Status === 'Active' && row.ExpirationDate >= '2026-09-10',
    ).length,
    1,
  );
  assert.equal(f.model.state.tag, BUILDER_MARKER + ':' + NEXT_NONCE);
});
test('an org expiring today is retained conservatively, never replaced earlier that day', () => {
  const f = fixture({ active: true });
  f.model.state.requestedAt = '2026-09-03T11:59:00.000Z';
  f.model.rows[0].CreatedDate = '2026-09-03T12:00:00.000Z';
  f.model.rows[0].ExpirationDate = '2026-09-10';
  assert.equal(f.run('acquire').status, 'available');
  noOrgMutations(f.model);
});
test('lost create response reconciles the same server tag and exact validated job ID', () => {
  const f = fixture();
  f.model.createFailure = { code: 'TIMEOUT', jobId: JOB_ID };
  assert.equal(f.run('acquire').status, 'available');
  assert.equal(f.model.state.jobId, JOB_ID);
  assert.equal(operations(f.model, 'org create scratch').length, 1);
  assert.equal(operations(f.model, 'org resume scratch').length, 1);
  assert.equal(f.run('acquire').status, 'available');
  assert.equal(operations(f.model, 'org create scratch').length, 1);
});
test('unknown create outcome without a visible tag stays pending across acquire retries', () => {
  const f = fixture();
  f.model.createFailure = { code: 'NETWORK' };
  f.model.hideCreate = true;
  assert.equal(f.run('acquire').status, 'pending');
  assert.equal(f.run('status').status, 'pending');
  assert.equal(f.run('acquire').status, 'pending');
  assert.equal(operations(f.model, 'org create scratch').length, 1);
  assert.equal(operations(f.model, 'org resume scratch').length, 0);
  assert.equal(f.model.state.phase, 'pending');
});
test('a proven quota-race rejection retires only the absent intent for later explicit acquire', () => {
  const f = fixture();
  f.model.createFailure = { code: 'SCRATCH_QUOTA' };
  f.model.hideCreate = true;
  assert.equal(f.run('acquire').status, 'failed');
  assert.equal(f.model.state.phase, 'released');
  assert.equal(operations(f.model, 'org create scratch').length, 1);
  f.model.createFailure = null;
  f.model.hideCreate = false;
  assert.equal(f.run('acquire').status, 'available');
  assert.equal(operations(f.model, 'org create scratch').length, 2);
});
test('resume timeout preserves the existing job and later acquire resumes without creating', () => {
  const f = fixture();
  f.model.resumeFailure = true;
  assert.equal(f.run('acquire').status, 'pending');
  f.model.resumeFailure = false;
  assert.equal(f.run('acquire').status, 'available');
  assert.equal(operations(f.model, 'org create scratch').length, 1);
  assert.equal(operations(f.model, 'org resume scratch').length, 2);
  assert.ok(
    operations(f.model, 'org resume scratch').every(
      (call) => call.args[call.args.indexOf('--job-id') + 1] === JOB_ID,
    ),
  );
});
test('a pending receipt never resumes an unrelated job even if the CLI reported that job ID', () => {
  const f = fixture({ active: true });
  f.model.state.phase = 'pending';
  delete f.model.state.orgId;
  f.model.rows[0].Description = BUILDER_MARKER + ':' + NEXT_NONCE;
  assert.throws(() => f.run('acquire'), BuilderOrgError);
  noOrgMutations(f.model);
});
test('quota refusal and receipt persistence failure occur before creation', () => {
  const quota = fixture();
  quota.model.quotaFailure = Object.assign(new Error(PRIVATE_TEXT), {
    exitCode: 75,
  });
  assert.throws(
    () => quota.run('acquire'),
    (error) =>
      error instanceof BuilderOrgError &&
      error.exitCode === 75 &&
      !error.message.includes(PRIVATE_TEXT),
  );
  noOrgMutations(quota.model);
  assert.equal(quota.model.state, null);
  const disk = fixture();
  disk.options.store.save = () => {
    throw new BuilderOrgError('LOCAL_STATE', 'Synthetic receipt write failed.');
  };
  assert.throws(() => disk.run('acquire'), BuilderOrgError);
  noOrgMutations(disk.model);
});
test('a held local per-hub lock refuses a concurrent builder operation', () => {
  const f = fixture();
  f.model.locked = true;
  assert.throws(
    () => f.run('acquire'),
    (error) => error.code === 'LOCKED',
  );
  noOrgMutations(f.model);
});
test('new receipt tags cannot reuse a historical request tag', () => {
  const f = fixture({ active: true });
  expire(f.model);
  assert.throws(
    () => f.run('acquire', { newId: () => NONCE }),
    BuilderOrgError,
  );
  assert.equal(operations(f.model, 'org create scratch').length, 0);
  assert.equal(operations(f.model, 'org delete scratch').length, 0);
});
test('CLI output is development-only and contains no usernames, auth values or verifier success format', () => {
  const f = fixture({ active: true });
  const output = [];
  const status = runBuilderCli({
    args: ['status'],
    env,
    now: () => new Date(clock),
    clientFactory: () => f.options.sf,
    storeFactory: () => f.options.store,
    write: (line) => output.push(line),
    error: (line) => output.push(line),
  });
  assert.equal(status, 0);
  assert.match(output[0], /^Development only:/);
  assert.doesNotMatch(
    output.join('\n'),
    /@|private-auth|Apex:|VERIFICATION REQUEST/,
  );
  const errors = [];
  const failed = runBuilderCli({
    args: ['status'],
    env,
    clientFactory: () => () => {
      throw new Error(PRIVATE_TEXT + ' ' + HUB_USER);
    },
    storeFactory: () => f.options.store,
    write: (line) => errors.push(line),
    error: (line) => errors.push(line),
  });
  assert.equal(failed, 1);
  assert.doesNotMatch(
    errors.join('\n'),
    /@|private-auth|Apex:|VERIFICATION REQUEST/,
  );
});
test('CLI rejects CI inputs without constructing a client or touching its local state store', () => {
  let touched = false;
  const output = [];
  assert.equal(
    runBuilderCli({
      args: ['acquire'],
      env: { ...env, CI: 'false' },
      clientFactory: () => {
        touched = true;
      },
      storeFactory: () => {
        touched = true;
      },
      error: (line) => output.push(line),
    }),
    1,
  );
  assert.equal(touched, false);
  assert.doesNotMatch(output.join('\n'), /private-auth|Apex:/);
});
