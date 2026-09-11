import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { LifecycleError, validateIdentity } from './scratch-lifecycle.mjs';

const filename = 'kusanya-scratch-intents.json';
const keys = [
  'schemaVersion',
  'devHub',
  'role',
  'runId',
  'sha',
  'tags',
  'rejectedTags',
];

function refuse() {
  throw new LifecycleError('RECONCILIATION_REQUIRED');
}

function bindHostedAttempt(env, identity) {
  if (env.GITHUB_ACTIONS !== 'true') return;
  if (
    identity.role !== 'ci' ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
    identity.runId !== `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`
  )
    refuse();
}

function journalPath(env) {
  if (
    typeof env.RUNNER_TEMP !== 'string' ||
    !isAbsolute(env.RUNNER_TEMP) ||
    typeof env.KUSANYA_CLEANUP_JOURNAL !== 'string' ||
    !isAbsolute(env.KUSANYA_CLEANUP_JOURNAL) ||
    resolve(env.KUSANYA_CLEANUP_JOURNAL) !== resolve(env.RUNNER_TEMP, filename)
  )
    refuse();
  return join(resolve(env.RUNNER_TEMP), filename);
}

function validate(record, { devHub, role, runId, sha }) {
  validateIdentity({ role, runId, sha });
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    Object.keys(record).sort().join(',') !== [...keys].sort().join(',') ||
    record.schemaVersion !== 1 ||
    record.devHub !== devHub ||
    record.role !== role ||
    record.runId !== runId ||
    record.sha !== sha ||
    !Array.isArray(record.tags) ||
    record.tags.length > 2 ||
    !Array.isArray(record.rejectedTags) ||
    new Set(record.tags).size !== record.tags.length ||
    new Set(record.rejectedTags).size !== record.rejectedTags.length
  )
    refuse();
  const prefix = `kusanya-${role}-v1__${runId}__${sha.slice(0, 12)}__`;
  for (const tag of record.tags) {
    if (
      typeof tag !== 'string' ||
      !tag.startsWith(prefix) ||
      !/^[a-f0-9]{12}$/.test(tag.slice(prefix.length))
    )
      refuse();
  }
  if (record.rejectedTags.some((tag) => !record.tags.includes(tag))) refuse();
  return record;
}

/** Read only a small, plain file at the fixed runner-temp path; never follow a link. */
export function readCleanupJournal({ env = process.env, identity }) {
  try {
    bindHostedAttempt(env, identity);
    const path = journalPath(env);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) refuse();
    return validate(JSON.parse(readFileSync(path, 'utf8')), identity);
  } catch {
    refuse();
  }
}

function durableWrite(path, record, initial) {
  // Exclusive creation refuses stale journals/links. Atomic replacement retains the
  // previous valid intent if interrupted; creation is never attempted before fsync.
  const target = initial ? path : `${path}.next`;
  const fd = openSync(target, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!initial) renameSync(target, path);
}

/** Trusted harness only: persist tags before create, not auth or raw CLI results. */
export function createCleanupJournal({ env = process.env, identity }) {
  if (!env.KUSANYA_CLEANUP_JOURNAL && env.GITHUB_ACTIONS !== 'true')
    return null;
  try {
    bindHostedAttempt(env, identity);
    const path = journalPath(env);
    const record = validate(
      { schemaVersion: 1, ...identity, tags: [], rejectedTags: [] },
      identity,
    );
    durableWrite(path, record, true);
    const update = (receipt, rejected) => {
      try {
        if (
          receipt.devHub !== identity.devHub ||
          receipt.role !== identity.role ||
          receipt.runId !== identity.runId ||
          receipt.sha !== identity.sha
        )
          refuse();
        const next = structuredClone(record);
        if (rejected) next.rejectedTags.push(receipt.tag);
        else next.tags.push(receipt.tag);
        validate(next, identity);
        durableWrite(path, next, false);
        Object.assign(record, next);
      } catch {
        refuse();
      }
    };
    return {
      onIntent: (receipt) => update(receipt, false),
      onRejected: (receipt) => update(receipt, true),
    };
  } catch {
    refuse();
  }
}
