import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DOCUMENTATION_EXEMPTION_LABEL,
  isOrdinaryDocumentation,
  classifyDocumentationDiff,
  collectDocumentationEvidence,
  isUtf8Prose,
  decideInfrastructureRetry,
} from './apex-pr-policy.mjs';

const HEAD = 'b'.repeat(40);
const BASE = 'a'.repeat(40);
function fixture(paths = ['docs/guide.md']) {
  const blobFacts = Object.create(null);
  const blobs = new Map();
  function blob(text) {
    const bytes = Buffer.from(text);
    const hash = createHash('sha1')
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex');
    blobs.set(hash, {
      sha: hash,
      encoding: 'base64',
      content: bytes.toString('base64'),
      size: bytes.length,
    });
    blobFacts[hash] = { text: true };
    return hash;
  }
  const baseTree = {
    sha: 'c'.repeat(40),
    truncated: false,
    tree: paths.map((path) => ({
      path,
      mode: '100644',
      type: 'blob',
      sha: blob(`Old ${path}\n`),
    })),
  };
  const headTree = {
    sha: 'd'.repeat(40),
    truncated: false,
    tree: paths.map((path) => ({
      path,
      mode: '100644',
      type: 'blob',
      sha: blob(`New ${path}\n`),
    })),
  };
  const repository = {
    full_name: 'kusanya-io/kusanya',
    default_branch: 'main',
  };
  const pr = {
    number: 9,
    state: 'open',
    merged: false,
    changed_files: paths.length,
    head: { sha: HEAD, repo: { full_name: repository.full_name } },
    base: { sha: BASE, ref: 'main', repo: { full_name: repository.full_name } },
  };
  return {
    repository,
    pr,
    expectedHeadSha: HEAD,
    checkoutSha: HEAD,
    files: headTree.tree.map((entry) => ({
      filename: entry.path,
      status: 'modified',
      sha: entry.sha,
    })),
    baseTree,
    headTree,
    blobFacts,
    blobs,
  };
}
const decision = (value) => classifyDocumentationDiff(value).decision;
function apiFixture(value) {
  const calls = [];
  const root = 'repos/kusanya-io/kusanya';
  const env = {
    KUSANYA_POLICY_REPOSITORY: 'kusanya-io/kusanya',
    KUSANYA_POLICY_PR_NUMBER: '9',
    KUSANYA_POLICY_HEAD_SHA: HEAD,
    KUSANYA_POLICY_CHECKOUT_SHA: HEAD,
    KUSANYA_POLICY_BASE_REF: 'main',
  };
  const api = async (endpoint) => {
    calls.push(endpoint);
    if (endpoint === root) return structuredClone(value.repository);
    if (endpoint === `${root}/pulls/9`) return structuredClone(value.pr);
    const page = endpoint.match(/\/files\?per_page=100&page=(\d+)$/);
    if (page)
      return structuredClone(
        value.files.slice((Number(page[1]) - 1) * 100, Number(page[1]) * 100),
      );
    if (endpoint === `${root}/git/commits/${BASE}`)
      return { sha: BASE, tree: { sha: value.baseTree.sha } };
    if (endpoint === `${root}/git/commits/${HEAD}`)
      return { sha: HEAD, tree: { sha: value.headTree.sha } };
    if (endpoint === `${root}/git/trees/${value.baseTree.sha}?recursive=1`)
      return structuredClone(value.baseTree);
    if (endpoint === `${root}/git/trees/${value.headTree.sha}?recursive=1`)
      return structuredClone(value.headTree);
    const blob = endpoint.match(/\/git\/blobs\/([a-f0-9]{40})$/);
    if (blob && value.blobs.has(blob[1]))
      return structuredClone(value.blobs.get(blob[1]));
    throw new Error('Unexpected API endpoint in fixture.');
  };
  return { env, api, calls };
}

test('exempts ordinary prose with exact full-SHA N/A label and no coverage claim', () => {
  const value = fixture([
    'README.md',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    'docs/guide.md',
    'docs/user/collect.md',
  ]);
  const result = classifyDocumentationDiff(value);
  assert.equal(result.decision, 'documentation-exemption');
  assert.equal(result.headSha, HEAD);
  assert.equal(result.exemptionLabel, DOCUMENTATION_EXEMPTION_LABEL);
  assert.equal(
    result.exemptionLabel,
    'Apex not run—approved documentation-only exemption',
  );
  assert.equal('coverage' in result, false);
});
test('critical policy, contracts, code, workflows and unknown files require Apex', () => {
  for (const path of [
    'docs/brief.md',
    'docs/verification.md',
    'docs/ci.md',
    'docs/threat-model.md',
    'docs/decisions/0001.md',
    'docs/openapi.yaml',
    'service/README.md',
    'mobile/README.md',
    'salesforce/README.md',
    '.github/workflows/ci.yml',
    'scripts/check.mjs',
    'package.json',
    'LICENSE',
    'notes.md',
    'docs/../README.md',
    'docs//guide.md',
    'docs\\guide.md',
  ]) {
    assert.equal(isOrdinaryDocumentation(path), false, path);
    assert.equal(decision(fixture([path])), 'full-apex', path);
  }
});
test('complete PR code plus a final documentation change never qualifies', () => {
  assert.equal(
    decision(fixture(['service/src/app.ts', 'docs/guide.md'])),
    'full-apex',
  );
});
test('renames check old and new path, and additions and deletions check their existing side', () => {
  const renamed = fixture();
  renamed.files[0].status = 'renamed';
  renamed.files[0].previous_filename = 'docs/old-guide.md';
  renamed.baseTree.tree[0].path = 'docs/old-guide.md';
  assert.equal(decision(renamed), 'documentation-exemption');
  renamed.files[0].previous_filename = 'scripts/old.md';
  renamed.baseTree.tree[0].path = 'scripts/old.md';
  assert.equal(decision(renamed), 'full-apex');
  for (const status of ['added', 'removed']) {
    const value = fixture(['README.md']);
    value.files[0].status = status;
    if (status === 'added') value.baseTree.tree = [];
    else {
      value.files[0].sha = value.baseTree.tree[0].sha;
      value.headTree.tree = [];
    }
    assert.equal(decision(value), 'documentation-exemption', status);
  }
});
test('symlinks, executable files, binary blobs and missing blob evidence require Apex', () => {
  for (const side of ['baseTree', 'headTree']) {
    for (const mode of ['120000', '100755', '160000', '040000']) {
      const value = fixture();
      value[side].tree[0].mode = mode;
      assert.equal(decision(value), 'full-apex', `${side} ${mode}`);
    }
    const value = fixture();
    value.blobFacts[value[side].tree[0].sha].text = false;
    assert.equal(decision(value), 'full-apex');
  }
  const value = fixture();
  value.blobFacts = {};
  assert.equal(decision(value), 'full-apex');
  assert.equal(
    isUtf8Prose(Buffer.from('English, Kiswahili, 日本語\n\ttext')),
    true,
  );
  assert.equal(isUtf8Prose(Buffer.from([0xff, 0xfe])), false);
  assert.equal(isUtf8Prose(Buffer.from('binary\0bytes')), false);
  assert.equal(isUtf8Prose(Buffer.from([27, 91, 50, 74])), false);
});
test('stale or shortened SHA, fork, closed PR and nondefault base require Apex', () => {
  for (const mutate of [
    (v) => {
      v.checkoutSha = BASE;
    },
    (v) => {
      v.expectedHeadSha = HEAD.slice(0, 7);
    },
    (v) => {
      v.pr.head.sha = BASE;
    },
    (v) => {
      v.pr.head.repo.full_name = 'fork/kusanya';
    },
    (v) => {
      v.pr.base.repo.full_name = 'fork/kusanya';
    },
    (v) => {
      v.pr.base.ref = 'feature';
    },
    (v) => {
      v.pr.state = 'closed';
    },
    (v) => {
      v.pr.merged = true;
    },
  ]) {
    const value = fixture();
    mutate(value);
    assert.equal(decision(value), 'full-apex');
  }
});
test('malformed, duplicate, truncated, missing and contradictory evidence fails closed', () => {
  for (const mutate of [
    (v) => {
      v.pr.changed_files = 2;
    },
    (v) => {
      v.files = [];
    },
    (v) => {
      v.files[0].status = 'copied';
    },
    (v) => {
      v.files[0].sha = BASE;
    },
    (v) => {
      v.files[0].previous_filename = 'README.md';
    },
    (v) => {
      v.files.push(v.files[0]);
      v.pr.changed_files = 2;
    },
    (v) => {
      v.baseTree.truncated = true;
    },
    (v) => {
      delete v.headTree.truncated;
    },
    (v) => {
      v.baseTree.tree.push(v.baseTree.tree[0]);
    },
    (v) => {
      v.headTree.tree = [];
    },
    (v) => {
      v.files[0].status = 'added';
    },
  ]) {
    const value = fixture();
    mutate(value);
    assert.equal(decision(value), 'full-apex');
  }
  for (const value of [undefined, null, {}, { expectedHeadSha: HEAD }])
    assert.equal(decision(value), 'full-apex');
});
test('read-only API adapter exhausts every page and verifies actual blob bytes', async () => {
  const value = fixture(
    Array.from({ length: 101 }, (_, index) => `docs/guide-${index}.md`),
  );
  const { env, api, calls } = apiFixture(value);
  assert.equal(
    decision(await collectDocumentationEvidence(env, api)),
    'documentation-exemption',
  );
  assert(calls.some((path) => path.endsWith('page=2')));
  assert.equal(calls.filter((path) => path.endsWith('/pulls/9')).length, 2);
});
test('exactly full page requests the following empty page', async () => {
  const { env, api, calls } = apiFixture(
    fixture(
      Array.from({ length: 100 }, (_, index) => `docs/guide-${index}.md`),
    ),
  );
  await collectDocumentationEvidence(env, api);
  assert(calls.some((path) => path.endsWith('page=2')));
});
test('API failure, file truncation, excessive counts and changed PR cannot exempt', async () => {
  const value = fixture();
  const { env, api } = apiFixture(value);
  await assert.rejects(
    collectDocumentationEvidence(env, async () => {
      throw new Error('API error');
    }),
  );
  value.pr.changed_files = 2;
  await assert.rejects(collectDocumentationEvidence(env, api), /incomplete/);
  value.pr.changed_files = 3001;
  await assert.rejects(collectDocumentationEvidence(env, api), /limit/);
  value.pr.changed_files = 1;
  value.headTree.truncated = true;
  await assert.rejects(collectDocumentationEvidence(env, api), /untruncated/);
  value.headTree.truncated = false;
  let prReads = 0;
  await assert.rejects(
    collectDocumentationEvidence(env, async (path) => {
      const response = await api(path);
      if (path.endsWith('/pulls/9') && ++prReads === 2)
        response.head.sha = BASE;
      return response;
    }),
    /exact SHA/,
  );
});
test('API adapter rejects mismatched or incomplete base64 blob data', async () => {
  for (const mutate of [
    (blob) => {
      blob.size += 1;
    },
    (blob) => {
      blob.content = Buffer.from('changed bytes').toString('base64');
      blob.size = 13;
    },
    (blob) => {
      blob.content += '===';
    },
  ]) {
    const value = fixture();
    const { env, api } = apiFixture(value);
    mutate(value.blobs.values().next().value);
    await assert.rejects(
      collectDocumentationEvidence(env, api),
      /blob response/,
    );
  }
});
test('CLI fails closed with JSON-only output and does not echo input or credentials', () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./apex-pr-policy.mjs', import.meta.url)),
      'classify',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        KUSANYA_POLICY_REPOSITORY: 'invalid-secret-sentinel',
        KUSANYA_POLICY_HEAD_SHA: HEAD,
      },
    },
  );
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).decision, 'full-apex');
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.includes('invalid-secret-sentinel'), false);
});

function attempt(overrides = {}) {
  return {
    runId: '100',
    attempt: 1,
    headSha: HEAD,
    startedAt: '2026-09-12T09:00:00Z',
    status: 'completed',
    conclusion: 'failure',
    verificationOutcome: 'failed-infrastructure',
    retryable: true,
    ...overrides,
  };
}
function budget(attempts = [], overrides = {}) {
  return decideInfrastructureRetry({
    headSha: HEAD,
    utcDay: '2026-09-12',
    attempts,
    currentRunId: '200',
    currentAttempt: 1,
    historyComplete: true,
    ...overrides,
  });
}
test('a complete empty history allows the initial attempt; only one infrastructure retry remains', () => {
  assert.deepEqual(
    { allowed: budget().allowed, kind: budget().kind },
    { allowed: true, kind: 'initial' },
  );
  assert.equal(budget([attempt()]).allowed, true);
  assert.equal(budget([attempt()]).kind, 'infrastructure-retry');
  assert.equal(budget([attempt(), attempt({ runId: '101' })]).allowed, false);
});
test('separate workflow runs and rerun attempts share the same head/day budget', () => {
  assert.equal(budget([attempt(), attempt({ attempt: 2 })]).allowed, false);
  assert.equal(
    budget([attempt(), attempt({ runId: '101', attempt: 1 })]).allowed,
    false,
  );
  assert.equal(
    budget([
      attempt(),
      attempt({
        runId: '200',
        status: 'in_progress',
        conclusion: null,
        verificationOutcome: null,
      }),
    ]).allowed,
    true,
  );
  assert.equal(budget([attempt({ runId: '200', attempt: 2 })]).allowed, false);
  assert.equal(
    budget([attempt({ runId: '200', attempt: 1 })], { currentAttempt: 2 }).kind,
    'infrastructure-retry',
  );
});
test('UTC date boundary resets only the infrastructure attempt count', () => {
  const yesterday = attempt({ startedAt: '2026-09-11T23:59:59Z' });
  assert.equal(budget([yesterday]).kind, 'initial');
  assert.equal(
    budget([
      yesterday,
      attempt({ runId: '101', startedAt: '2026-09-12T00:00:00Z' }),
    ]).kind,
    'infrastructure-retry',
  );
  assert.equal(
    budget([attempt({ headSha: BASE, verificationOutcome: 'failed-tests' })])
      .kind,
    'initial',
  );
});
test('test failures, prior passes, cleanup failures and creation rejections on the same head never authorize a retry', () => {
  for (const verificationOutcome of [
    'failed-tests',
    'passed',
    'failed-cleanup',
    'failed-creation-rejected',
  ]) {
    for (const startedAt of ['2026-09-11T12:00:00Z', '2026-09-12T12:00:00Z']) {
      assert.equal(
        budget([
          attempt({
            verificationOutcome,
            startedAt,
            conclusion:
              verificationOutcome === 'passed' ? 'success' : 'failure',
          }),
        ]).allowed,
        false,
        verificationOutcome,
      );
    }
  }
});
test('quota blocking permits one capacity-recovery rerun but still consumes its head/day slot', () => {
  const blocked = attempt({
    verificationOutcome: 'blocked-quota',
    retryable: true,
  });
  assert.equal(budget([blocked]).kind, 'infrastructure-retry');
  assert.equal(
    budget([
      blocked,
      attempt({ runId: '101', verificationOutcome: 'blocked-quota' }),
    ]).allowed,
    false,
  );
});
test('only explicitly retryable infrastructure markers authorize retry', () => {
  for (const verificationOutcome of [
    'failed-infrastructure',
    'blocked-quota',
  ]) {
    for (const retryable of [undefined, false, null, 'true'])
      assert.equal(
        budget([attempt({ verificationOutcome, retryable })]).allowed,
        false,
      );
  }
  for (const verificationOutcome of [undefined, null, 'unknown', 'failure'])
    assert.equal(budget([attempt({ verificationOutcome })]).allowed, false);
  for (const conclusion of [
    undefined,
    null,
    'success',
    'cancelled',
    'timed_out',
  ])
    assert.equal(budget([attempt({ conclusion })]).allowed, false);
});
test('only collector-proven pre-verification cancellations share the counted infrastructure retry budget', () => {
  const cancelled = attempt({
    conclusion: 'cancelled',
    verificationNotStarted: true,
  });
  assert.equal(budget([cancelled]).kind, 'infrastructure-retry');
  assert.equal(budget([cancelled, attempt({ runId: '101' })]).allowed, false);
  assert.equal(
    budget([cancelled, { ...cancelled, runId: '101' }]).allowed,
    false,
  );
  assert.equal(
    budget([{ ...cancelled, startedAt: '2026-09-11T23:59:59Z' }]).kind,
    'initial',
  );
  for (const verificationNotStarted of [undefined, false, null, 'true', 1])
    assert.equal(
      budget([{ ...cancelled, verificationNotStarted }]).allowed,
      false,
    );
  for (const retryable of [undefined, false, null, 'true'])
    assert.equal(budget([{ ...cancelled, retryable }]).allowed, false);
  for (const verificationOutcome of [
    'blocked-quota',
    'passed',
    'failed-tests',
    'failed-cleanup',
    'failed-creation-rejected',
  ])
    assert.equal(
      budget([{ ...cancelled, verificationOutcome }]).allowed,
      false,
    );
  for (const conclusion of [undefined, 'success', 'timed_out', 'skipped'])
    assert.equal(budget([{ ...cancelled, conclusion }]).allowed, false);
});
test('missing history, malformed timestamps, active attempts and duplicates deny consumption', () => {
  for (const historyComplete of [false, undefined, null])
    assert.equal(budget([], { historyComplete }).allowed, false);
  for (const status of ['queued', 'in_progress', 'waiting', undefined])
    assert.equal(budget([attempt({ status })]).allowed, false);
  for (const startedAt of [
    undefined,
    'yesterday',
    '2026-02-30T12:00:00Z',
    '2026-09-13T00:00:00Z',
    '2026-09-12T09:00:00+03:00',
  ])
    assert.equal(budget([attempt({ startedAt })]).allowed, false);
  assert.equal(budget([attempt(), attempt()]).allowed, false);
  assert.equal(budget([], { utcDay: '2026-02-30' }).allowed, false);
  assert.equal(budget([], { headSha: HEAD.slice(0, 7) }).allowed, false);
  assert.equal(budget([], { currentAttempt: 0 }).allowed, false);
  assert.equal(budget([], { attempts: null }).allowed, false);
  assert.equal(budget([attempt({ runId: 1.5 })]).allowed, false);
});
