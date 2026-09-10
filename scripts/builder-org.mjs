import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSalesforceClient } from './salesforce-client.mjs';
import { preflight } from './scratch-lifecycle.mjs';

export const BUILDER_MARKER = 'kusanya-builder-v1';
export const BUILDER_ALIAS_PREFIX = 'kusanya-builder-';
const DAY = 86400000;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const JOB = /^2SR[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const ORG = /^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const directory = fileURLToPath(new URL('../', import.meta.url));

export class BuilderOrgError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.name = 'BuilderOrgError';
    this.code = code;
    this.exitCode = exitCode;
  }
}
function fail(code, message) {
  throw new BuilderOrgError(code, message);
}
function orgId(value) {
  if (typeof value !== 'string' || !ORG.test(value))
    fail('IDENTITY', 'Builder identity could not be verified.');
  return value.slice(0, 15);
}
export function builderAliasForHub(hubId) {
  return (
    BUILDER_ALIAS_PREFIX +
    createHash('sha256').update(orgId(hubId)).digest('hex').slice(0, 16)
  );
}
function localEnvironment(env) {
  if (
    ['CI', 'GITHUB_ACTIONS', 'SF_DEV_HUB_AUTH_URL'].some((key) => key in env) ||
    Object.keys(env).some((key) =>
      ['CI', 'GITHUB_ACTIONS', 'SF_DEV_HUB_AUTH_URL'].includes(
        key.toUpperCase(),
      ),
    )
  ) {
    fail(
      'LOCAL_ONLY',
      'Builder org management is local development only; CI and CI authentication inputs are refused.',
    );
  }
  const alias = env.KUSANYA_DEV_HUB;
  if (
    typeof alias !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(alias) ||
    /(?:^|[-_])ci(?:[-_]|$)/i.test(alias)
  ) {
    fail(
      'LOCAL_HUB',
      'Set KUSANYA_DEV_HUB to an explicit authenticated local Dev Hub alias, never a username or CI alias.',
    );
  }
  return alias;
}
function checkedDays(days) {
  if (!Number.isInteger(days) || days < 1 || days > 7)
    fail(
      'DURATION',
      'Builder duration must be an integer from one to seven days.',
    );
  return days;
}
export function parseBuilderArgs(args) {
  if (args.length === 1 && ['status', 'acquire', 'release'].includes(args[0]))
    return { command: args[0], days: 7 };
  if (
    args.length === 3 &&
    args[0] === 'acquire' &&
    args[1] === '--days' &&
    /^[1-7]$/.test(args[2])
  )
    return { command: 'acquire', days: Number(args[2]) };
  fail(
    'USAGE',
    'Usage: node scripts/builder-org.mjs status | acquire [--days 1..7] | release',
  );
}
function call(sf, stage, args) {
  try {
    const result = sf(stage, args);
    if (!result || result.status !== 0 || result.result === undefined)
      throw new Error();
    return result.result;
  } catch (error) {
    const safe = new BuilderOrgError(
      'SF_OPERATION',
      'Builder operation was not confirmed; inspect Salesforce CLI privately and retry this command. No raw output was logged.',
    );
    if (typeof error?.jobId === 'string' && JOB.test(error.jobId))
      safe.jobId = error.jobId;
    if (error?.code === 'SCRATCH_QUOTA') safe.code = 'SCRATCH_QUOTA';
    throw safe;
  }
}
function discover(sf, requestedAlias) {
  const listing = call(sf, 'Builder Dev Hub discovery', [
    'org',
    'list',
    '--all',
  ]);
  if (
    !Array.isArray(listing.nonScratchOrgs) ||
    !Array.isArray(listing.scratchOrgs)
  )
    fail('DISCOVERY', 'Builder org discovery was incomplete.');
  const matches = listing.nonScratchOrgs.filter(
    (org) => org.alias === requestedAlias,
  );
  if (
    matches.length !== 1 ||
    matches[0].isDevHub !== true ||
    !/^[A-Za-z0-9@._+-]+$/.test(matches[0].username ?? '')
  ) {
    fail(
      'LOCAL_HUB',
      'The explicit local alias does not uniquely identify an authenticated Dev Hub.',
    );
  }
  const hub = {
    id: orgId(matches[0].orgId ?? matches[0].id),
    username: matches[0].username,
  };
  return { hub, listing };
}
function receipt(value, hub) {
  if (!value) return null;
  const fields = [
    'version',
    'marker',
    'hubId',
    'alias',
    'tag',
    'requestedAt',
    'durationDays',
    'phase',
    'jobId',
    'orgId',
  ];
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    value.version !== 1 ||
    value.marker !== BUILDER_MARKER ||
    value.hubId !== hub.id ||
    value.alias !== builderAliasForHub(hub.id) ||
    typeof value.tag !== 'string' ||
    !value.tag.startsWith(BUILDER_MARKER + ':') ||
    !UUID.test(value.tag.slice(BUILDER_MARKER.length + 1)) ||
    !Number.isFinite(Date.parse(value.requestedAt)) ||
    !['pending', 'active', 'released'].includes(value.phase) ||
    (value.jobId !== undefined && !JOB.test(value.jobId)) ||
    (value.orgId !== undefined &&
      (!ORG.test(value.orgId) || value.orgId.length !== 15))
  ) {
    fail(
      'RECEIPT',
      'The local builder receipt is invalid or belongs to another Dev Hub; no org was changed.',
    );
  }
  checkedDays(value.durationDays);
  return { ...value };
}
function records(sf, hub) {
  const result = call(sf, 'Builder ownership discovery', [
    'data',
    'query',
    '--target-org',
    hub.username,
    '--query',
    `SELECT Id,OrgName,Description,Status,ScratchOrg,SignupUsername,CreatedDate,ExpirationDate,DurationDays FROM ScratchOrgInfo WHERE OrgName = '${BUILDER_MARKER}'`,
  ]);
  if (
    result.done !== true ||
    !Array.isArray(result.records) ||
    result.totalSize !== result.records.length ||
    result.records.some(
      (row) =>
        row.OrgName !== BUILDER_MARKER ||
        !JOB.test(row.Id ?? '') ||
        !['New', 'Creating', 'Active', 'Error', 'Deleted'].includes(row.Status),
    )
  ) {
    fail(
      'DISCOVERY',
      'Builder ownership records were incomplete or inconsistent.',
    );
  }
  return result.records;
}
function expiry(row) {
  const value = row.ExpirationDate;
  const date =
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? Date.parse(value + 'T00:00:00.000Z')
      : NaN;
  if (
    !Number.isFinite(date) ||
    new Date(date).toISOString().slice(0, 10) !== value
  )
    fail('EXPIRY', 'Builder expiration could not be verified.');
  return date;
}
function isLive(row, now) {
  return (
    ['New', 'Creating'].includes(row.Status) ||
    (row.Status === 'Active' &&
      expiry(row) >=
        Date.parse(now.toISOString().slice(0, 10) + 'T00:00:00.000Z'))
  );
}
function owned(row, state, clock) {
  if (
    !state ||
    row.Description !== state.tag ||
    (state.jobId && row.Id !== state.jobId) ||
    (state.orgId &&
      row.Status === 'Active' &&
      orgId(row.ScratchOrg) !== state.orgId)
  ) {
    fail(
      'OWNERSHIP',
      'Builder marker ownership is unproven; no foreign org will be adopted or deleted.',
    );
  }
  if (row.DurationDays !== state.durationDays)
    fail('EXPIRY', 'Builder lifetime does not match the local receipt.');
  if (row.Status === 'Active') {
    const created = Date.parse(row.CreatedDate);
    const expires = expiry(row);
    if (
      !Number.isFinite(created) ||
      expires <= created ||
      expires - created > state.durationDays * DAY ||
      created < Date.parse(state.requestedAt) - 300000 ||
      created > clock.getTime() + 300000
    ) {
      fail(
        'EXPIRY',
        'Builder lifetime exceeds its approved duration or cannot be verified.',
      );
    }
    orgId(row.ScratchOrg);
  }
}
function aliases(sf, alias) {
  const all = call(sf, 'Builder reserved alias discovery', ['alias', 'list']);
  if (!Array.isArray(all))
    fail('DISCOVERY', 'Local aliases could not be verified.');
  const matches = all.filter((entry) => entry.alias === alias);
  if (matches.length > 1)
    fail('OWNERSHIP', 'The reserved builder alias is ambiguous.');
  return matches[0]?.value;
}
function localOwnership(sf, hub, row, state, required, clock) {
  owned(row, state, clock);
  const listing = call(sf, 'Builder local identity confirmation', [
    'org',
    'list',
    '--all',
  ]);
  const target = aliases(sf, state.alias);
  if (
    !Array.isArray(listing.scratchOrgs) ||
    !Array.isArray(listing.nonScratchOrgs)
  )
    fail('DISCOVERY', 'Local builder identity discovery was incomplete.');
  if (listing.nonScratchOrgs.some((entry) => entry.alias === state.alias))
    fail(
      'OWNERSHIP',
      'The reserved builder alias belongs to an unrelated org.',
    );
  const matching = listing.scratchOrgs.filter(
    (entry) =>
      entry.username === row.SignupUsername &&
      orgId(entry.orgId ?? entry.id) === orgId(row.ScratchOrg),
  );
  if (target !== undefined && target !== row.SignupUsername)
    fail(
      'OWNERSHIP',
      'The reserved builder alias points elsewhere; no org was changed.',
    );
  if (
    matching.length > 1 ||
    matching.some((entry) => entry.devHubUsername !== hub.username)
  )
    fail(
      'OWNERSHIP',
      'The builder org does not have the expected Dev Hub association.',
    );
  const confirmed = matching.length === 1 && target === row.SignupUsername;
  if (required && !confirmed)
    fail(
      'OWNERSHIP',
      'The owned builder org is not authenticated under its reserved alias; no org was changed.',
    );
  return confirmed;
}

/** Store only an ownership receipt, never usernames or authentication material. */
export function createFileBuilderStore(root = directory) {
  const base = realpathSync(root);
  let folder = base;
  for (const segment of ['work', 'builder-org']) {
    folder = join(folder, segment);
    if (existsSync(folder)) {
      if (lstatSync(folder).isSymbolicLink() || realpathSync(folder) !== folder)
        fail(
          'LOCAL_STATE',
          'Builder state directory must remain inside the checkout.',
        );
    } else mkdirSync(folder);
  }
  const file = (hub) => join(folder, builderAliasForHub(hub) + '.json');
  return {
    withLock(hub, operation) {
      const lock = join(folder, builderAliasForHub(hub) + '.lock');
      try {
        mkdirSync(lock);
      } catch {
        fail(
          'LOCKED',
          'Another builder operation or an unreconciled local lock exists; no second org will be created.',
        );
      }
      try {
        return operation();
      } finally {
        rmdirSync(lock);
      }
    },
    load(hub) {
      try {
        if (!existsSync(file(hub))) return null;
        if (lstatSync(file(hub)).isSymbolicLink()) throw new Error();
        return JSON.parse(readFileSync(file(hub), 'utf8'));
      } catch {
        fail(
          'LOCAL_STATE',
          'The local builder receipt could not be read safely.',
        );
      }
    },
    save(hub, value) {
      const target = file(hub);
      const temporary = target + '.' + randomUUID() + '.tmp';
      try {
        if (existsSync(target) && lstatSync(target).isSymbolicLink())
          throw new Error();
        writeFileSync(temporary, JSON.stringify(value) + '\n', {
          flag: 'wx',
          mode: 0o600,
        });
        renameSync(temporary, target);
      } catch {
        if (existsSync(temporary)) unlinkSync(temporary);
        fail(
          'LOCAL_STATE',
          'The local builder receipt could not be saved; no new request may be retried without reconciliation.',
        );
      }
    },
  };
}

/** Synchronous orchestration with injected Salesforce client/store for synthetic tests. */
export function manageBuilderOrg({
  command,
  days = 7,
  env = process.env,
  sf,
  store,
  now = () => new Date(),
  newId = randomUUID,
  checkQuota = preflight,
}) {
  const requestedAlias = localEnvironment(env);
  if (!['status', 'acquire', 'release'].includes(command))
    fail('USAGE', 'Builder command must be status, acquire, or release.');
  checkedDays(days);
  const clock = now();
  if (!(clock instanceof Date) || !Number.isFinite(clock.getTime()))
    fail('CLOCK', 'A valid clock is required for builder expiration checks.');
  const { hub } = discover(sf, requestedAlias);
  return store.withLock(hub.id, () => {
    let state = receipt(store.load(hub.id), hub);
    const persist = () => store.save(hub.id, state);
    const summary = (status, row) => ({
      status,
      alias: builderAliasForHub(hub.id),
      ...(row?.Status === 'Active' ? { expiresOn: row.ExpirationDate } : {}),
    });
    const inspect = () => {
      const all = records(sf, hub);
      const live = all.filter((row) => isLive(row, clock));
      if (live.length > 1)
        fail(
          'DUPLICATE',
          'More than one marked builder org or request exists in this Dev Hub; automatic changes are refused.',
        );
      if (live.length) {
        owned(live[0], state, clock);
        if (state.phase === 'released')
          fail(
            'OWNERSHIP',
            'A released builder receipt unexpectedly has a live org; automatic changes are refused.',
          );
      }
      const matches = state
        ? all.filter((row) => row.Description === state.tag)
        : [];
      if (matches.length > 1)
        fail(
          'DUPLICATE',
          'The builder request tag is ambiguous; automatic changes are refused.',
        );
      if (matches.length) owned(matches[0], state, clock);
      return { all, live: live[0], own: matches[0] };
    };
    let snapshot = inspect();

    const continuePending = () => {
      snapshot = inspect();
      const row = snapshot.own;
      if (!row) return summary('pending');
      if (['Error', 'Deleted'].includes(row.Status)) {
        state = { ...state, phase: 'released', jobId: row.Id };
        persist();
        return summary('failed');
      }
      if (row.Status === 'Active' && !isLive(row, clock))
        return summary('expired', row);
      state = { ...state, jobId: row.Id };
      persist();
      // A reserved alias may be absent while the same request is provisioning,
      // but an alias explicitly pointing elsewhere must never be overwritten.
      const localTarget = aliases(sf, state.alias);
      if (localTarget !== undefined && localTarget !== row.SignupUsername)
        fail(
          'OWNERSHIP',
          'The reserved builder alias points elsewhere; no org was changed.',
        );
      if (
        row.Status === 'Active' &&
        localOwnership(sf, hub, row, state, false, clock)
      ) {
        state = { ...state, phase: 'active', orgId: orgId(row.ScratchOrg) };
        persist();
        return summary('available', row);
      }
      try {
        call(sf, 'Builder resume owned request', [
          'org',
          'resume',
          'scratch',
          '--job-id',
          row.Id,
          '--wait',
          '1',
        ]);
      } catch {
        return summary('pending');
      }
      snapshot = inspect();
      const resumed = snapshot.own;
      if (!resumed || resumed.Status !== 'Active') return summary('pending');
      if (!isLive(resumed, clock)) return summary('expired', resumed);
      localOwnership(sf, hub, resumed, state, true, clock);
      state = { ...state, phase: 'active', orgId: orgId(resumed.ScratchOrg) };
      persist();
      return summary('available', resumed);
    };

    if (command === 'status') {
      if (snapshot.live?.Status === 'Active') {
        if (state.phase === 'pending') return summary('pending', snapshot.live);
        localOwnership(sf, hub, snapshot.live, state, true, clock);
        return summary('available', snapshot.live);
      }
      if (snapshot.live || state?.phase === 'pending')
        return summary('pending');
      if (snapshot.own?.Status === 'Active')
        return summary('expired', snapshot.own);
      return summary('none');
    }

    if (command === 'release') {
      if (!snapshot.live) {
        if (state?.phase === 'pending' && !snapshot.own)
          return summary('pending');
        return summary(
          snapshot.own?.Status === 'Active' ? 'expired' : 'none',
          snapshot.own,
        );
      }
      if (snapshot.live.Status !== 'Active') return summary('pending');
      localOwnership(sf, hub, snapshot.live, state, true, clock);
      // Recheck the exact hub/tag immediately before deletion. Use the positively
      // verified username internally, not a mutable alias, as the deletion target.
      const candidate = snapshot.live;
      snapshot = inspect();
      if (
        !snapshot.live ||
        snapshot.live.Id !== candidate.Id ||
        snapshot.live.ScratchOrg !== candidate.ScratchOrg ||
        snapshot.live.SignupUsername !== candidate.SignupUsername
      ) {
        fail(
          'OWNERSHIP',
          'Builder identity changed before release; no org was deleted.',
        );
      }
      call(sf, 'Builder release owned org', [
        'org',
        'delete',
        'scratch',
        '--target-org',
        candidate.SignupUsername,
        '--no-prompt',
      ]);
      snapshot = inspect();
      if (snapshot.live) return summary('pending');
      state = {
        ...state,
        phase: 'released',
        jobId: candidate.Id,
        orgId: orgId(candidate.ScratchOrg),
      };
      persist();
      return summary('released');
    }

    if (snapshot.live?.Status === 'Active' && state.phase === 'active') {
      localOwnership(sf, hub, snapshot.live, state, true, clock);
      return summary('available', snapshot.live);
    }
    if (state?.phase === 'pending') return continuePending();
    if (snapshot.live)
      fail(
        'OWNERSHIP',
        'An existing builder request cannot be replaced automatically.',
      );

    // Reaching here means no live marked request exists. Retire a stale alias
    // only when the prior receipt and exact historical row positively own it.
    const existingAlias = aliases(sf, builderAliasForHub(hub.id));
    if (existingAlias !== undefined) {
      if (
        !snapshot.own ||
        !state ||
        snapshot.own.SignupUsername !== existingAlias ||
        !(
          snapshot.own.Status === 'Deleted' ||
          snapshot.own.Status === 'Error' ||
          !isLive(snapshot.own, clock)
        )
      ) {
        fail(
          'OWNERSHIP',
          'A stale reserved alias cannot be attributed to this builder receipt; no org was changed.',
        );
      }
      owned(snapshot.own, state, clock);
      call(sf, 'Builder retire owned expired alias', [
        'alias',
        'unset',
        state.alias,
      ]);
    }
    try {
      checkQuota(sf, { devHub: hub.username, needed: 1, now: clock });
    } catch (error) {
      throw new BuilderOrgError(
        'QUOTA',
        'Builder creation preflight did not permit another scratch org; retry only after checking Dev Hub capacity privately.',
        error?.exitCode === 75 ? 75 : 1,
      );
    }
    // Check again after quota reads, before saving intent or submitting a create.
    snapshot = inspect();
    if (snapshot.live)
      fail(
        'DUPLICATE',
        'A builder request appeared during preflight; no new request was submitted.',
      );
    const nonce = newId();
    if (
      typeof nonce !== 'string' ||
      !UUID.test(nonce) ||
      snapshot.all.some(
        (row) => row.Description === BUILDER_MARKER + ':' + nonce,
      )
    )
      fail('IDENTITY', 'A fresh builder request tag could not be generated.');
    state = {
      version: 1,
      marker: BUILDER_MARKER,
      hubId: hub.id,
      alias: builderAliasForHub(hub.id),
      tag: BUILDER_MARKER + ':' + nonce,
      requestedAt: clock.toISOString(),
      durationDays: days,
      phase: 'pending',
    };
    persist();
    try {
      const created = call(sf, 'scratch-create', [
        'org',
        'create',
        'scratch',
        '--target-dev-hub',
        hub.username,
        '--definition-file',
        'config/project-scratch-def.json',
        '--alias',
        state.alias,
        '--duration-days',
        String(days),
        '--name',
        BUILDER_MARKER,
        '--description',
        state.tag,
        '--async',
      ]);
      const jobId = created.jobId ?? created.id ?? created.scratchOrgInfo?.Id;
      if (typeof jobId === 'string' && JOB.test(jobId)) {
        state = { ...state, jobId };
        persist();
      }
    } catch (error) {
      if (typeof error?.jobId === 'string' && JOB.test(error.jobId)) {
        state = { ...state, jobId: error.jobId };
        persist();
      }
      if (error?.code === 'SCRATCH_QUOTA' && !state.jobId) {
        // A recognized quota rejection submitted no creation. Confirm the exact
        // intent is absent before retiring it; unknown outcomes stay pending.
        snapshot = inspect();
        if (!snapshot.own && !snapshot.live) {
          state = { ...state, phase: 'released' };
          persist();
          return summary('failed');
        }
      }
      // Never clear this intent or submit another create after an ambiguous result.
    }
    return continuePending();
  });
}

export function runBuilderCli({
  args = process.argv.slice(2),
  env = process.env,
  now = () => new Date(),
  write = (line) => console.log(line),
  error = (line) => console.error(line),
  clientFactory = createSalesforceClient,
  storeFactory = createFileBuilderStore,
} = {}) {
  try {
    localEnvironment(env);
    const options = parseBuilderArgs(args);
    const outcome = manageBuilderOrg({
      ...options,
      env,
      now,
      sf: clientFactory({ cwd: join(directory, 'salesforce'), env }),
      store: storeFactory(directory),
    });
    const messages = {
      available: `Development only: owned builder org is available as ${outcome.alias}.`,
      pending:
        'Development only: the existing builder request remains pending; acquire reconciles the same request and never creates a second one.',
      none: 'Development only: no active owned builder org is available.',
      expired:
        'Development only: the owned builder org has expired; no org was deleted.',
      released: 'Development only: the exact owned builder org was released.',
      failed:
        'Development only: the owned creation request ended without an available org; no automatic replacement was submitted.',
    };
    write(messages[outcome.status]);
    write('This tool does not run tests or provide verification evidence.');
    return ['pending', 'failed'].includes(outcome.status) ? 75 : 0;
  } catch (failure) {
    error(
      failure instanceof BuilderOrgError
        ? failure.message
        : 'Builder operation failed safely. Inspect local state privately; no raw Salesforce output was logged.',
    );
    return failure instanceof BuilderOrgError ? failure.exitCode : 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = runBuilderCli();
