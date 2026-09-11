import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOCUMENTATION_EXEMPTION_LABEL =
  'Apex not run—approved documentation-only exemption';
const sha = (value) =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const validRunId = (value) =>
  (typeof value === 'string' || positive(value)) &&
  /^[1-9][0-9]*$/.test(String(value));
const ordinaryPath = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  !/[\\\u0000-\u001f\u007f]/.test(value) &&
  value.split('/').every((part) => part && part !== '.' && part !== '..');
const criticalDocuments = new Set([
  'docs/brief.md',
  'docs/verification.md',
  'docs/ci.md',
  'docs/threat-model.md',
]);

export function isOrdinaryDocumentation(path) {
  return (
    ordinaryPath(path) &&
    !criticalDocuments.has(path) &&
    !path.startsWith('docs/decisions/') &&
    (['README.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md'].includes(path) ||
      /^docs\/.+\.md$/.test(path))
  );
}
function requireCondition(condition, reason) {
  if (!condition) throw new Error(reason);
}
function verifyIdentity({
  pr,
  repository,
  expectedHeadSha,
  checkoutSha,
  baseRef,
}) {
  requireCondition(
    repository &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(
        repository.full_name,
      ) &&
      typeof repository.default_branch === 'string' &&
      repository.default_branch.length > 0,
    'Repository identity is missing or malformed.',
  );
  requireCondition(
    sha(expectedHeadSha) && checkoutSha === expectedHeadSha,
    'The checkout and expected full head SHA must match.',
  );
  requireCondition(
    pr?.state === 'open' &&
      pr.merged === false &&
      positive(pr.number) &&
      pr.head?.repo?.full_name === repository.full_name &&
      pr.base?.repo?.full_name === repository.full_name &&
      pr.head?.sha === expectedHeadSha &&
      sha(pr.base?.sha) &&
      pr.base?.ref === repository.default_branch &&
      (baseRef === undefined || baseRef === pr.base.ref),
    'An open same-repository PR against the default branch at this exact SHA is required.',
  );
  requireCondition(
    positive(pr.changed_files),
    'A complete nonempty pull request diff is required.',
  );
}
function treeEntries(tree) {
  requireCondition(
    tree?.truncated === false && sha(tree.sha) && Array.isArray(tree.tree),
    'A complete untruncated Git tree is required.',
  );
  const entries = new Map();
  for (const entry of tree.tree) {
    requireCondition(
      ordinaryPath(entry?.path) &&
        sha(entry.sha) &&
        typeof entry.mode === 'string' &&
        ['blob', 'tree', 'commit'].includes(entry.type) &&
        !entries.has(entry.path),
      'Malformed or duplicate Git tree entry.',
    );
    entries.set(entry.path, entry);
  }
  return entries;
}

// blobFacts come from inspecting bytes, never from trusting a .md suffix.
// Trees are retrieved from the immutable base/head commits in the PR response.
export function classifyDocumentationDiff(input) {
  const fallback = (reason) => ({
    schemaVersion: 1,
    decision: 'full-apex',
    headSha: sha(input?.expectedHeadSha) ? input.expectedHeadSha : null,
    reason,
  });
  try {
    verifyIdentity(input);
    const { pr, files, baseTree, headTree, blobFacts } = input;
    requireCondition(
      Array.isArray(files) && files.length === pr.changed_files,
      'Pull request file count is incomplete or inconsistent.',
    );
    const before = treeEntries(baseTree);
    const after = treeEntries(headTree);
    const seen = new Set();
    function regularText(entries, path) {
      const entry = entries.get(path);
      requireCondition(
        entry?.type === 'blob' && entry.mode === '100644',
        'Every affected documentation path must be a non-executable regular file.',
      );
      requireCondition(
        blobFacts?.[entry.sha]?.text === true,
        'Every affected documentation blob must be verified UTF-8 text.',
      );
      return entry;
    }
    for (const file of files) {
      requireCondition(
        file &&
          isOrdinaryDocumentation(file.filename) &&
          sha(file.sha) &&
          !seen.has(file.filename) &&
          ['added', 'modified', 'removed', 'renamed'].includes(file.status),
        'The complete diff includes a non-allowlisted, duplicate, or unknown change.',
      );
      seen.add(file.filename);
      let resultEntry;
      if (file.status === 'renamed') {
        requireCondition(
          isOrdinaryDocumentation(file.previous_filename) &&
            file.previous_filename !== file.filename,
          'Both sides of a rename must be ordinary documentation.',
        );
        regularText(before, file.previous_filename);
        resultEntry = regularText(after, file.filename);
        requireCondition(
          !before.has(file.filename) && !after.has(file.previous_filename),
          'Rename tree entries are inconsistent.',
        );
      } else {
        requireCondition(
          file.previous_filename === undefined,
          'Unexpected previous filename on a non-rename change.',
        );
        if (file.status !== 'added')
          resultEntry = regularText(before, file.filename);
        if (file.status !== 'removed')
          resultEntry = regularText(after, file.filename);
        requireCondition(
          (file.status !== 'added' || !before.has(file.filename)) &&
            (file.status !== 'removed' || !after.has(file.filename)),
          'Added or deleted file disagrees with the immutable Git trees.',
        );
      }
      requireCondition(
        resultEntry.sha === file.sha,
        'File-list and Git-tree blob identities disagree.',
      );
    }
    return {
      schemaVersion: 1,
      decision: 'documentation-exemption',
      headSha: input.expectedHeadSha,
      reason:
        'The complete PR diff contains only approved ordinary prose files.',
      exemptionLabel: DOCUMENTATION_EXEMPTION_LABEL,
    };
  } catch (error) {
    return fallback(error.message);
  }
}
export function isUtf8Prose(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
  } catch {
    return false;
  }
}

// Caller authenticates outcomes against the trusted CI harness log or positive
// Jobs API skipped-verification proof for this exact run/attempt/head.
// PR bodies and uploaded artifacts are not proof.
export function decideInfrastructureRetry({
  headSha,
  utcDay,
  attempts,
  currentRunId,
  currentAttempt,
  historyComplete,
}) {
  const deny = (reason) => ({ allowed: false, kind: null, reason });
  if (
    !sha(headSha) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(utcDay ?? '') ||
    !Number.isFinite(Date.parse(`${utcDay}T00:00:00Z`)) ||
    new Date(`${utcDay}T00:00:00Z`).toISOString().slice(0, 10) !== utcDay ||
    !validRunId(currentRunId) ||
    !positive(currentAttempt) ||
    historyComplete !== true ||
    !Array.isArray(attempts)
  )
    return deny(
      'Complete authenticated history and valid current identity are required.',
    );
  let usedToday = 0;
  const seen = new Set();
  for (const previous of attempts) {
    if (
      !validRunId(previous?.runId) ||
      !positive(previous.attempt) ||
      !sha(previous.headSha)
    )
      return deny('Malformed workflow attempt identity.');
    const key = `${previous.runId}-${previous.attempt}`;
    if (seen.has(key)) return deny('Duplicate workflow attempt history.');
    seen.add(key);
    if (previous.headSha !== headSha) continue;
    if (
      String(previous.runId) === String(currentRunId) &&
      previous.attempt === currentAttempt
    )
      continue;
    if (
      String(previous.runId) === String(currentRunId) &&
      previous.attempt > currentAttempt
    )
      return deny(
        'History contains a later attempt of the current workflow run.',
      );
    if (
      typeof previous.startedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(
        previous.startedAt,
      ) ||
      !Number.isFinite(Date.parse(previous.startedAt)) ||
      new Date(previous.startedAt).toISOString().slice(0, 10) !==
        previous.startedAt.slice(0, 10) ||
      previous.startedAt.slice(0, 10) > utcDay ||
      previous.status !== 'completed'
    )
      return deny(
        'Incomplete, active, or invalid workflow history cannot authorize another attempt.',
      );
    const outcome = previous.verificationOutcome;
    if (outcome === 'passed')
      return deny(
        'This head already passed; duplicate validation is not authorized.',
      );
    if (outcome === 'failed-tests')
      return deny(
        'A test failure requires a changed head, not an infrastructure retry.',
      );
    if (outcome === 'failed-cleanup')
      return deny(
        'Cleanup failure requires human recovery before another attempt.',
      );
    if (outcome === 'failed-creation-rejected')
      return deny(
        'A proven creation rejection is non-retryable; diagnose and correct the cause before a newly reviewed head.',
      );
    // The collector alone establishes this proof from completed Jobs API
    // metadata; outcome logs cannot grant a cancelled attempt this exception.
    const cancelledBeforeVerification =
      previous.conclusion === 'cancelled' &&
      previous.verificationNotStarted === true &&
      outcome === 'failed-infrastructure';
    if (
      !['failed-infrastructure', 'blocked-quota'].includes(outcome) ||
      (previous.conclusion !== 'failure' && !cancelledBeforeVerification) ||
      previous.retryable !== true
    )
      return deny(
        'Unknown, non-retryable, or contradictory validation evidence cannot authorize a retry.',
      );
    if (previous.startedAt.slice(0, 10) === utcDay) usedToday += 1;
  }
  if (usedToday >= 2)
    return deny(
      'The initial attempt and one infrastructure retry are already consumed for this head and UTC day.',
    );
  return {
    allowed: true,
    kind: usedToday === 0 ? 'initial' : 'infrastructure-retry',
    reason:
      usedToday === 0
        ? 'No prior attempt consumed this head and UTC day.'
        : 'One infrastructure retry remains for this head and UTC day.',
  };
}

// Inject transport for tests; production only makes read-only GET gh API calls.
export async function collectDocumentationEvidence(env, api) {
  const repositoryName = env.KUSANYA_POLICY_REPOSITORY;
  const number = env.KUSANYA_POLICY_PR_NUMBER;
  const expectedHeadSha = env.KUSANYA_POLICY_HEAD_SHA;
  requireCondition(
    /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(
      repositoryName ?? '',
    ) &&
      /^[1-9][0-9]*$/.test(number ?? '') &&
      sha(expectedHeadSha),
    'Invalid repository, PR number, or full head SHA.',
  );
  const root = `repos/${repositoryName}`;
  const repository = await api(root);
  requireCondition(
    repository.full_name === repositoryName,
    'Repository API identity mismatch.',
  );
  const pr = await api(`${root}/pulls/${number}`);
  const input = {
    pr,
    repository,
    expectedHeadSha,
    checkoutSha: env.KUSANYA_POLICY_CHECKOUT_SHA,
    baseRef: env.KUSANYA_POLICY_BASE_REF,
  };
  verifyIdentity(input);
  requireCondition(
    pr.number === Number(number),
    'Pull request API identity mismatch.',
  );
  const files = [];
  requireCondition(
    pr.changed_files <= 3000,
    'Pull request exceeds the complete file-list API limit.',
  );
  for (let page = 1; page <= 31; page += 1) {
    const batch = await api(
      `${root}/pulls/${number}/files?per_page=100&page=${page}`,
    );
    requireCondition(
      Array.isArray(batch) && batch.length <= 100,
      'Malformed file-list page.',
    );
    files.push(...batch);
    requireCondition(
      files.length <= pr.changed_files,
      'File-list pagination returned unexpected extra files.',
    );
    if (batch.length < 100) break;
  }
  requireCondition(
    files.length === pr.changed_files,
    'File-list pagination was incomplete.',
  );
  async function readTree(commitSha) {
    const commit = await api(`${root}/git/commits/${commitSha}`);
    requireCondition(
      commit?.sha === commitSha && sha(commit.tree?.sha),
      'Commit tree identity mismatch.',
    );
    const tree = await api(`${root}/git/trees/${commit.tree.sha}?recursive=1`);
    requireCondition(
      tree?.sha === commit.tree.sha,
      'Git tree identity mismatch.',
    );
    treeEntries(tree);
    return tree;
  }
  const baseTree = await readTree(pr.base.sha);
  const headTree = await readTree(expectedHeadSha);
  const blobFacts = Object.create(null);
  const paths = new Set(
    files
      .flatMap((file) => [file?.filename, file?.previous_filename])
      .filter(isOrdinaryDocumentation),
  );
  for (const tree of [baseTree, headTree]) {
    for (const entry of tree.tree) {
      if (
        !paths.has(entry.path) ||
        entry.type !== 'blob' ||
        entry.mode !== '100644' ||
        blobFacts[entry.sha]
      )
        continue;
      const blob = await api(`${root}/git/blobs/${entry.sha}`);
      requireCondition(
        blob?.sha === entry.sha &&
          blob.encoding === 'base64' &&
          typeof blob.content === 'string' &&
          Number.isSafeInteger(blob.size) &&
          blob.size >= 0 &&
          /^[A-Za-z0-9+/=\r\n]*$/.test(blob.content),
        'Malformed Git blob response.',
      );
      const bytes = Buffer.from(blob.content, 'base64');
      const digest = createHash('sha1')
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest('hex');
      requireCondition(
        bytes.length === blob.size &&
          bytes.toString('base64') === blob.content.replace(/[\r\n]/g, '') &&
          digest === entry.sha,
        'Incomplete or mismatched Git blob response.',
      );
      blobFacts[entry.sha] = { text: isUtf8Prose(bytes) };
    }
  }
  const finalPr = await api(`${root}/pulls/${number}`);
  verifyIdentity({ ...input, pr: finalPr });
  requireCondition(
    finalPr.base.sha === pr.base.sha &&
      finalPr.changed_files === pr.changed_files &&
      finalPr.number === pr.number,
    'Pull request changed during classification.',
  );
  return { ...input, files, baseTree, headTree, blobFacts };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let result;
  try {
    requireCondition(
      process.argv.length === 3 && process.argv[2] === 'classify',
      'Use: node scripts/apex-pr-policy.mjs classify',
    );
    const api = (endpoint) =>
      JSON.parse(
        execFileSync('gh', ['api', '--method', 'GET', endpoint], {
          encoding: 'utf8',
          timeout: 60000,
          maxBuffer: 32 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    result = classifyDocumentationDiff(
      await collectDocumentationEvidence(process.env, api),
    );
  } catch {
    result = {
      schemaVersion: 1,
      decision: 'full-apex',
      headSha: sha(process.env.KUSANYA_POLICY_HEAD_SHA)
        ? process.env.KUSANYA_POLICY_HEAD_SHA
        : null,
      reason:
        'Documentation exemption could not be established from complete trusted API evidence.',
    };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
