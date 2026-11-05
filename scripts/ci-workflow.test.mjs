import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8',
).replaceAll('\r\n', '\n');

test('public CI installs the exact hashed actionlint release and enables ShellCheck', () => {
  const digest =
    '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8';
  const url =
    'https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz';

  assert.match(workflow, /ACTIONLINT_VERSION: '1\.7\.12'/);
  assert.ok(workflow.includes(`ACTIONLINT_SHA256: ${digest}`));
  assert.equal(workflow.split(url).length - 1, 1);
  assert.match(workflow, /sha256sum --check --strict/);
  assert.match(workflow, /command -v shellcheck >\/dev\/null/);
  assert.match(workflow, /actionlint -shellcheck shellcheck/);
  assert.doesNotMatch(workflow, /-shellcheck(?:=| )['"]{2}/);
  assert.ok(workflow.indexOf('Install pinned actionlint') >= 0);
  assert.ok(
    workflow.indexOf('Install pinned actionlint') <
      workflow.indexOf('Lint GitHub Actions workflows'),
  );
  assert.ok(
    workflow.indexOf('Lint GitHub Actions workflows') <
      workflow.indexOf('npm run format:check'),
  );
});
