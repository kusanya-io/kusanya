import { randomUUID } from 'node:crypto';
import { SalesforceCommandError } from './salesforce-client.mjs';

const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const safeHub = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9@._+-]+$/.test(value);
const salesforceId = (value, prefix) =>
  typeof value === 'string' &&
  new RegExp(`^${prefix}[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$`).test(value);
const sameId = (left, right) =>
  typeof left === 'string' &&
  typeof right === 'string' &&
  left.slice(0, 15) === right.slice(0, 15);
const tagPattern =
  /^kusanya-(ci|verifier)-v1__([A-Za-z0-9][A-Za-z0-9-]{0,31})__([a-f0-9]{12})__([a-f0-9]{12})$/;
const rejectedWithoutOrg = (row) =>
  row?.Status === 'Error' &&
  Object.hasOwn(row, 'ScratchOrg') &&
  (row.ScratchOrg === null || row.ScratchOrg === '');

export class LifecycleError extends Error {
  constructor(code = 'INVALID_INPUT') {
    const allowed = [
      'INVALID_INPUT',
      'INVALID_QUOTA',
      'INVALID_QUERY',
      'OWNERSHIP_MISMATCH',
      'RECONCILIATION_REQUIRED',
      'CLEANUP_FAILED',
      'CREATION_FAILED',
      'CREATION_REJECTED',
      'JOURNAL_UNAVAILABLE',
    ];
    super(
      `Scratch lifecycle failed (${allowed.includes(code) ? code : 'INVALID_INPUT'}); raw Salesforce details withheld.`,
    );
    this.name = 'LifecycleError';
    this.code = allowed.includes(code) ? code : 'INVALID_INPUT';
    this.exitCode = 1;
    this.retryable = false;
  }
}

export class QuotaBlockedError extends Error {
  constructor(report) {
    super(
      `BLOCKED: scratch quota requires ${report.needed}; active ${report.active.remaining}/${report.active.max}, daily ${report.daily.remaining}/${report.daily.max}; next UTC slot ${report.nextSlotUtc ?? 'unavailable'}.`,
    );
    this.name = 'QuotaBlockedError';
    this.code = 'SCRATCH_QUOTA';
    this.exitCode = 75;
    this.retryable = true;
    this.report = report;
  }
}

export function validateIdentity({ role, runId, sha }) {
  if (
    !['ci', 'verifier'].includes(role) ||
    typeof runId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/.test(runId) ||
    typeof sha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(sha)
  )
    throw new LifecycleError();
  return { role, runId, sha };
}

function query(sf, devHub, soql) {
  const result = sf('scratch-read', [
    'data',
    'query',
    '--target-org',
    devHub,
    '--query',
    soql,
  ]).result;
  if (
    !result ||
    result.done !== true ||
    !Array.isArray(result.records) ||
    result.totalSize !== result.records.length
  )
    throw new LifecycleError('INVALID_QUERY');
  return result.records;
}

/** Read-only current-quota preflight. It reserves no slots; creation can still race. */
export function preflight(sf, { devHub, needed = 1, now = new Date() }) {
  if (
    !safeHub(devHub) ||
    ![1, 2].includes(needed) ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime())
  )
    throw new LifecycleError();
  const limits = sf('quota-read', [
    'org',
    'list',
    'limits',
    '--target-org',
    devHub,
  ]).result;
  if (!Array.isArray(limits)) throw new LifecycleError('INVALID_QUOTA');
  const read = (name) => {
    const matches = limits.filter((entry) => entry?.name === name);
    const item = matches[0];
    if (
      matches.length !== 1 ||
      !integer(item.max) ||
      !integer(item.remaining) ||
      item.remaining > item.max
    )
      throw new LifecycleError('INVALID_QUOTA');
    return { max: item.max, remaining: item.remaining };
  };
  const active = read('ActiveScratchOrgs');
  const daily = read('DailyScratchOrgs');
  // Daily capacity is not a rolling 24-hour window. Until a provider reset
  // schedule is independently confirmed, creation history cannot predict it.
  // Authoritative live Remaining values alone admit or block this attempt.
  const nextSlotUtc = null;
  const report = { active, daily, needed, nextSlotUtc };
  if (active.remaining < needed || daily.remaining < needed)
    throw new QuotaBlockedError(report);
  return report;
}

function readOwned(sf, receipt) {
  const where = receipt.requestId
    ? `Id = '${receipt.requestId}'`
    : `OrgName = '${receipt.tag}'`;
  const rows = query(
    sf,
    receipt.devHub,
    `SELECT Id, OrgName, Status, ScratchOrg, SignupUsername FROM ScratchOrgInfo WHERE ${where}`,
  );
  if (rows.length > 1) throw new LifecycleError('OWNERSHIP_MISMATCH');
  const row = rows[0];
  if (!row) return null;
  if (
    !salesforceId(row.Id, '2SR') ||
    row.OrgName !== receipt.tag ||
    (receipt.requestId && !sameId(row.Id, receipt.requestId)) ||
    typeof row.Status !== 'string'
  )
    throw new LifecycleError('OWNERSHIP_MISMATCH');
  if (
    row.Status === 'Active' &&
    (!salesforceId(row.ScratchOrg, '00D') || !safeHub(row.SignupUsername))
  )
    throw new LifecycleError('OWNERSHIP_MISMATCH');
  if (
    receipt.orgId &&
    row.Status === 'Active' &&
    !sameId(row.ScratchOrg, receipt.orgId)
  )
    throw new LifecycleError('OWNERSHIP_MISMATCH');
  return row;
}

function assertReceipt(receipt) {
  validateIdentity(receipt);
  const parsed = tagPattern.exec(receipt.tag ?? '');
  if (
    !safeHub(receipt.devHub) ||
    !parsed ||
    parsed[1] !== receipt.role ||
    parsed[2] !== receipt.runId ||
    parsed[3] !== receipt.sha.slice(0, 12) ||
    !salesforceId(receipt.requestId, '2SR') ||
    !salesforceId(receipt.orgId, '00D')
  )
    throw new LifecycleError('OWNERSHIP_MISMATCH');
}

/** Deletes only positively re-matched created orgs, using the Dev Hub API. */
export function cleanupOwnedOrgs(sf, receipts) {
  let deleted = 0;
  let alreadyDeleted = 0;
  let failed = false;
  for (const receipt of receipts) {
    try {
      assertReceipt(receipt);
      const row = readOwned(sf, receipt);
      if (!row) throw new LifecycleError('OWNERSHIP_MISMATCH');
      if (row.Status === 'Deleted') {
        alreadyDeleted += 1;
        continue;
      }
      if (row.Status !== 'Active')
        throw new LifecycleError('OWNERSHIP_MISMATCH');
      const active = query(
        sf,
        receipt.devHub,
        `SELECT Id, ScratchOrg FROM ActiveScratchOrg WHERE ScratchOrg = '${receipt.orgId.slice(0, 15)}'`,
      );
      if (
        active.length !== 1 ||
        !salesforceId(active[0].Id, '2AS') ||
        !sameId(active[0].ScratchOrg, receipt.orgId)
      )
        throw new LifecycleError('OWNERSHIP_MISMATCH');
      const result = sf('scratch-cleanup', [
        'data',
        'delete',
        'record',
        '--target-org',
        receipt.devHub,
        '--sobject',
        'ActiveScratchOrg',
        '--record-id',
        active[0].Id,
      ]).result;
      if (result?.success !== true) throw new LifecycleError('CLEANUP_FAILED');
      deleted += 1;
    } catch {
      failed = true;
    }
  }
  if (failed) throw new LifecycleError('CLEANUP_FAILED');
  return { deleted, alreadyDeleted };
}

/** Reconciles only this exact run's persisted intent allowlist, never broad discovery. */
export function cleanupRunIntents(
  sf,
  { devHub, role, runId, sha, tags, rejectedTags = [] },
) {
  validateIdentity({ role, runId, sha });
  if (
    !safeHub(devHub) ||
    !Array.isArray(tags) ||
    tags.length > 2 ||
    new Set(tags).size !== tags.length ||
    !Array.isArray(rejectedTags) ||
    new Set(rejectedTags).size !== rejectedTags.length ||
    rejectedTags.some((tag) => !tags.includes(tag))
  )
    throw new LifecycleError('OWNERSHIP_MISMATCH');
  // Validate the complete allowlist before any Salesforce read or write.
  for (const tag of tags) {
    const parsed = typeof tag === 'string' && tagPattern.exec(tag);
    if (
      !parsed ||
      parsed[1] !== role ||
      parsed[2] !== runId ||
      parsed[3] !== sha.slice(0, 12)
    )
      throw new LifecycleError('OWNERSHIP_MISMATCH');
  }
  const receipts = [];
  let alreadyDeleted = 0;
  let rejected = 0;
  let unresolved = false;
  for (const tag of tags) {
    const intent = { devHub, role, runId, sha, tag };
    try {
      const row = readOwned(sf, intent);
      if (row?.Status === 'Active') {
        receipts.push({ ...intent, requestId: row.Id, orgId: row.ScratchOrg });
      } else if (row?.Status === 'Deleted') {
        alreadyDeleted += 1;
      } else if (
        rejectedWithoutOrg(row) ||
        (!row && rejectedTags.includes(tag))
      ) {
        rejected += 1;
      } else {
        unresolved = true;
      }
    } catch {
      unresolved = true;
    }
  }
  const cleanup = cleanupOwnedOrgs(sf, receipts);
  if (unresolved) throw new LifecycleError('RECONCILIATION_REQUIRED');
  return {
    deleted: cleanup.deleted,
    alreadyDeleted: alreadyDeleted + cleanup.alreadyDeleted,
    rejected,
  };
}

/** One Phase-0 org by default; count two is atomic acquisition, not a C10 claim. */
export function acquireScratchOrgs(sf, options) {
  const {
    devHub,
    role,
    runId,
    sha,
    count = 1,
    now = new Date(),
    currentTime = () => new Date(),
    nonce = () => randomUUID().replaceAll('-', '').slice(0, 12),
    onEvent = () => {},
    onIntent = () => {},
    onRejected = () => {},
  } = options;
  validateIdentity({ role, runId, sha });
  if (
    !safeHub(devHub) ||
    ![1, 2].includes(count) ||
    typeof onIntent !== 'function' ||
    typeof onRejected !== 'function' ||
    Object.hasOwn(options, 'targetOrg') ||
    Object.hasOwn(options, 'existingOrg')
  )
    throw new LifecycleError();
  const quota = preflight(sf, { devHub, needed: count, now });
  const receipts = [];
  const tags = new Set();
  try {
    for (let index = 0; index < count; index += 1) {
      const suffix = nonce();
      if (typeof suffix !== 'string' || !/^[a-f0-9]{12}$/.test(suffix))
        throw new LifecycleError();
      const tag = `kusanya-${role}-v1__${runId}__${sha.slice(0, 12)}__${suffix}`;
      if (tags.has(tag)) throw new LifecycleError();
      tags.add(tag);
      const receipt = { devHub, role, runId, sha, tag };
      // Never adopt an existing org, even if its name matches a new random tag.
      if (readOwned(sf, receipt))
        throw new LifecycleError('OWNERSHIP_MISMATCH');
      onEvent(`Fresh scratch ownership tag: ${tag}.`);
      // Persistence is synchronous and must succeed before a creation can start.
      const notify = (callback) => {
        try {
          const returned = callback({ devHub, role, runId, sha, tag });
          if (returned?.then) throw new LifecycleError();
        } catch {
          throw new LifecycleError('RECONCILIATION_REQUIRED');
        }
      };
      notify(onIntent);
      let creationError;
      try {
        sf('scratch-create', [
          'org',
          'create',
          'scratch',
          '--target-dev-hub',
          devHub,
          '--definition-file',
          'config/project-scratch-def.json',
          '--alias',
          tag,
          '--name',
          tag,
          '--duration-days',
          '1',
          '--wait',
          '5',
        ]);
      } catch (error) {
        creationError = error;
        if (error instanceof SalesforceCommandError && error.jobId)
          receipt.requestId = error.jobId;
      }
      let row;
      try {
        row = readOwned(sf, receipt);
      } catch {
        throw new LifecycleError('RECONCILIATION_REQUIRED');
      }
      if (row?.Status === 'Active') {
        Object.assign(receipt, {
          requestId: row.Id,
          orgId: row.ScratchOrg,
          username: row.SignupUsername,
        });
        receipts.push(receipt);
        if (creationError) throw creationError;
      } else if (
        rejectedWithoutOrg(row) ||
        (!row &&
          creationError instanceof SalesforceCommandError &&
          ['SCRATCH_QUOTA', 'CREATION_REJECTED'].includes(creationError.code))
      ) {
        notify(onRejected);
        if (creationError?.code === 'SCRATCH_QUOTA') {
          const current = preflight(sf, {
            devHub,
            needed: count - index,
            now: currentTime(),
          });
          throw new QuotaBlockedError(current);
        }
        throw new LifecycleError('CREATION_REJECTED');
      } else if (row?.Status === 'Deleted') {
        throw creationError ?? new LifecycleError('CREATION_FAILED');
      } else {
        // A request may finish after a CLI timeout. Do not retry creation, adopt an
        // unknown org, or pretend cleanup succeeded; the ended-run janitor can reconcile it.
        throw new LifecycleError('RECONCILIATION_REQUIRED');
      }
    }
    return { orgs: receipts, quota };
  } catch (error) {
    cleanupOwnedOrgs(sf, receipts);
    throw error;
  }
}

/** Default dry-run; callers must inject authoritative, read-only run evidence. */
export function runJanitor(sf, { devHub, role, getRunStatus, apply = false }) {
  if (
    !safeHub(devHub) ||
    !['ci', 'verifier'].includes(role) ||
    typeof getRunStatus !== 'function' ||
    typeof apply !== 'boolean'
  )
    throw new LifecycleError();
  const rows = query(
    sf,
    devHub,
    "SELECT Id, OrgName, Status, ScratchOrg, SignupUsername FROM ScratchOrgInfo WHERE Status = 'Active'",
  );
  const eligible = [];
  for (const row of rows) {
    const parsed = tagPattern.exec(row.OrgName ?? '');
    if (!parsed || parsed[1] !== role || row.Status !== 'Active') continue;
    let run;
    try {
      run = getRunStatus({ role, runId: parsed[2], headShaPrefix: parsed[3] });
    } catch {
      continue;
    }
    if (
      !run ||
      run.status !== 'completed' ||
      run.runId !== parsed[2] ||
      typeof run.headSha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(run.headSha) ||
      !run.headSha.startsWith(parsed[3])
    )
      continue;
    const receipt = {
      devHub,
      role,
      runId: parsed[2],
      sha: run.headSha,
      tag: row.OrgName,
      requestId: row.Id,
      orgId: row.ScratchOrg,
    };
    assertReceipt(receipt);
    eligible.push(receipt);
  }
  const cleanup = apply
    ? cleanupOwnedOrgs(sf, eligible)
    : { deleted: 0, alreadyDeleted: 0 };
  return {
    dryRun: !apply,
    eligibleTags: eligible.map((receipt) => receipt.tag),
    ...cleanup,
  };
}
