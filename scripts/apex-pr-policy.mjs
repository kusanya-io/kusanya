import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOCUMENTATION_EXEMPTION_LABEL =
  'Apex not run—approved documentation-only exemption';
export const SALESFORCE_IDENTICAL_EXEMPTION_LABEL =
  'Apex not run—trusted salesforce tree identical to accepted main';
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
  acceptedBaseSha,
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
    sha(expectedHeadSha) &&
      checkoutSha === expectedHeadSha &&
      sha(acceptedBaseSha),
    'The checkout, expected head and accepted base must be full SHAs.',
  );
  requireCondition(
    pr?.state === 'open' &&
      pr.merged === false &&
      positive(pr.number) &&
      pr.head?.repo?.full_name === repository.full_name &&
      pr.base?.repo?.full_name === repository.full_name &&
      pr.head?.sha === expectedHeadSha &&
      pr.base?.sha === acceptedBaseSha &&
      pr.base?.ref === repository.default_branch &&
      (baseRef === undefined || baseRef === pr.base.ref),
    'An open same-repository PR against the default branch at this exact SHA is required.',
  );
  requireCondition(
    positive(pr.changed_files),
    'A complete nonempty pull request diff is required.',
  );
}

function isVerificationBoundaryPath(path) {
  return (
    ordinaryPath(path) &&
    (path === '.github' ||
      path.startsWith('.github/') ||
      path === 'scripts' ||
      path.startsWith('scripts/'))
  );
}

function validateCompleteDiff(input) {
  verifyIdentity(input);
  const { pr, files, baseTree, headTree } = input;
  requireCondition(
    Array.isArray(files) && files.length === pr.changed_files,
    'Pull request file count is incomplete or inconsistent.',
  );
  const before = treeEntries(baseTree);
  const after = treeEntries(headTree);
  const seen = new Set();
  for (const file of files) {
    requireCondition(
      file &&
        ordinaryPath(file.filename) &&
        sha(file.sha) &&
        !seen.has(file.filename) &&
        ['added', 'modified', 'removed', 'renamed'].includes(file.status),
      'The complete diff includes a malformed, duplicate, or unknown change.',
    );
    seen.add(file.filename);
    let resultEntry;
    if (file.status === 'renamed') {
      requireCondition(
        ordinaryPath(file.previous_filename) &&
          file.previous_filename !== file.filename &&
          before.has(file.previous_filename) &&
          after.has(file.filename) &&
          !before.has(file.filename) &&
          !after.has(file.previous_filename),
        'Rename entries are incomplete or inconsistent.',
      );
      resultEntry = after.get(file.filename);
    } else {
      requireCondition(
        file.previous_filename === undefined,
        'Unexpected previous filename on a non-rename change.',
      );
      if (file.status === 'added') {
        requireCondition(
          !before.has(file.filename) && after.has(file.filename),
          'Added file disagrees with the immutable Git trees.',
        );
        resultEntry = after.get(file.filename);
      } else if (file.status === 'removed') {
        requireCondition(
          before.has(file.filename) && !after.has(file.filename),
          'Removed file disagrees with the immutable Git trees.',
        );
        resultEntry = before.get(file.filename);
      } else {
        requireCondition(
          before.has(file.filename) && after.has(file.filename),
          'Modified file is missing from an immutable Git tree.',
        );
        resultEntry = after.get(file.filename);
      }
    }
    requireCondition(
      resultEntry?.sha === file.sha,
      'File-list and Git-tree identities disagree.',
    );
  }
  return { before, after };
}

function salesforceTree(entries) {
  const entry = entries.get('salesforce');
  requireCondition(
    entry?.type === 'tree' && entry.mode === '040000' && sha(entry.sha),
    'A regular salesforce directory tree is required on both commits.',
  );
  return entry.sha;
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

export function classifyApexRequirement(input) {
  const fallback = (reason) => ({
    schemaVersion: 2,
    decision: 'full-apex',
    headSha: sha(input?.expectedHeadSha) ? input.expectedHeadSha : null,
    baseSha: sha(input?.acceptedBaseSha) ? input.acceptedBaseSha : null,
    reason,
  });
  try {
    requireCondition(
      ['pull_request', 'workflow_dispatch'].includes(input?.eventName),
      'A supported trusted workflow event is required.',
    );
    const { before, after } = validateCompleteDiff(input);
    if (input.eventName === 'workflow_dispatch')
      return fallback(
        'Manual dispatch always requires real Apex evidence for the reviewed head.',
      );

    const documentation = classifyDocumentationDiff(input);
    if (documentation.decision === 'documentation-exemption')
      return {
        ...documentation,
        schemaVersion: 2,
        baseSha: input.acceptedBaseSha,
      };

    const changedPaths = input.files.flatMap((file) => [
      file.filename,
      file.previous_filename,
    ]);
    if (changedPaths.some(isVerificationBoundaryPath))
      return fallback(
        'Workflow and script trust-boundary changes require real Apex evidence.',
      );
    if (
      changedPaths.some(
        (path) => path === 'salesforce' || path?.startsWith('salesforce/'),
      )
    )
      return fallback(
        'The complete diff contains a Salesforce source-tree change.',
      );

    const acceptedSalesforceTree = salesforceTree(before);
    const reviewedSalesforceTree = salesforceTree(after);
    if (acceptedSalesforceTree !== reviewedSalesforceTree)
      return fallback(
        'The reviewed Salesforce tree differs from accepted main.',
      );
    return {
      schemaVersion: 2,
      decision: 'salesforce-identical-exemption',
      headSha: input.expectedHeadSha,
      baseSha: input.acceptedBaseSha,
      salesforceTreeSha: acceptedSalesforceTree,
      reason:
        'The reviewed salesforce directory tree is byte-identical to accepted main.',
      exemptionLabel: SALESFORCE_IDENTICAL_EXEMPTION_LABEL,
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
  const eventName = env.KUSANYA_POLICY_EVENT_NAME;
  requireCondition(
    /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(
      repositoryName ?? '',
    ) &&
      /^[1-9][0-9]*$/.test(number ?? '') &&
      sha(expectedHeadSha) &&
      ['pull_request', 'workflow_dispatch'].includes(eventName),
    'Invalid repository, PR number, full head SHA, or workflow event.',
  );
  const root = `repos/${repositoryName}`;
  const repository = await api(root);
  requireCondition(
    repository.full_name === repositoryName,
    'Repository API identity mismatch.',
  );
  requireCondition(
    ordinaryPath(repository.default_branch),
    'Repository default branch is malformed.',
  );
  const baseRefEndpoint = `${root}/git/ref/heads/${encodeURIComponent(
    repository.default_branch,
  )}`;
  const acceptedBaseRef = await api(baseRefEndpoint);
  requireCondition(
    acceptedBaseRef?.ref === `refs/heads/${repository.default_branch}` &&
      acceptedBaseRef.object?.type === 'commit' &&
      sha(acceptedBaseRef.object.sha),
    'Accepted default-branch ref is missing or malformed.',
  );
  const acceptedBaseSha = acceptedBaseRef.object.sha;
  const pr = await api(`${root}/pulls/${number}`);
  const input = {
    pr,
    repository,
    expectedHeadSha,
    checkoutSha: env.KUSANYA_POLICY_CHECKOUT_SHA,
    acceptedBaseSha,
    baseRef: env.KUSANYA_POLICY_BASE_REF,
    eventName,
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
  const baseTree = await readTree(acceptedBaseSha);
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
  const finalAcceptedBaseRef = await api(baseRefEndpoint);
  verifyIdentity({ ...input, pr: finalPr });
  requireCondition(
    finalPr.base.sha === pr.base.sha &&
      finalPr.changed_files === pr.changed_files &&
      finalPr.number === pr.number &&
      finalAcceptedBaseRef?.ref === acceptedBaseRef.ref &&
      finalAcceptedBaseRef.object?.type === 'commit' &&
      finalAcceptedBaseRef.object.sha === acceptedBaseSha,
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
    result = classifyApexRequirement(
      await collectDocumentationEvidence(process.env, api),
    );
  } catch {
    result = {
      schemaVersion: 2,
      decision: 'full-apex',
      headSha: sha(process.env.KUSANYA_POLICY_HEAD_SHA)
        ? process.env.KUSANYA_POLICY_HEAD_SHA
        : null,
      reason:
        'An exemption could not be established from complete trusted API evidence.',
    };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
