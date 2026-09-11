import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveGitBash } from './git-bash.mjs';

test('cmd and bin Git launchers resolve the root Bash launcher', () => {
  for (const directory of ['cmd', 'bin']) {
    const expected = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const checked = [];
    const actual = resolveGitBash(
      `C:\\Program Files\\Git\\${directory}\\git.exe\r\n`,
      (path) => {
        checked.push(path);
        return path === expected;
      },
    );
    assert.equal(actual, expected);
    assert.deepEqual(checked, [expected]);
  }
});
test('mingw32 and mingw64 Git launchers resolve the installation root', () => {
  for (const architecture of ['mingw32', 'mingw64']) {
    const expected = 'C:\\Program Files\\Git\\bin\\bash.exe';
    assert.equal(
      resolveGitBash(
        `C:\\Program Files\\Git\\${architecture}\\bin\\git.exe`,
        (path) => path === expected,
      ),
      expected,
    );
  }
});
test('usr/bin Bash is used when the preferred root launcher is absent', () => {
  const checked = [];
  const expected = 'D:\\Portable Git\\usr\\bin\\bash.exe';
  assert.equal(
    resolveGitBash('D:\\Portable Git\\mingw64\\bin\\git.exe', (path) => {
      checked.push(path);
      return path === expected;
    }),
    expected,
  );
  assert.deepEqual(checked, ['D:\\Portable Git\\bin\\bash.exe', expected]);
});
test('all Git discoveries are searched, with repeated installation roots checked once', () => {
  const expected = 'D:\\Git\\usr\\bin\\bash.exe';
  const checked = [];
  const output = [
    '',
    'C:\\Windows\\System32\\git.exe',
    'C:\\Incomplete Git\\mingw64\\bin\\git.exe',
    'c:\\incomplete git\\cmd\\git.exe',
    'D:\\Git\\cmd\\git.exe',
    '',
  ].join('\r\n');
  assert.equal(
    resolveGitBash(output, (path) => {
      checked.push(path);
      return path === expected;
    }),
    expected,
  );
  assert.deepEqual(checked, [
    'C:\\Incomplete Git\\bin\\bash.exe',
    'C:\\Incomplete Git\\usr\\bin\\bash.exe',
    'D:\\Git\\bin\\bash.exe',
    expected,
  ]);
});
test('Windows path matching tolerates case and forward slashes', () => {
  const expected = 'C:\\Git\\bin\\bash.exe';
  assert.equal(
    resolveGitBash('C:/Git/MINGW64/BIN/GIT.EXE', (path) => path === expected),
    expected,
  );
});
test('missing Git Bash fails without trying a generic Windows or WSL launcher', () => {
  const checked = [];
  assert.throws(
    () =>
      resolveGitBash('C:\\Git\\cmd\\git.exe', (path) => {
        checked.push(path);
        return path === 'C:\\Windows\\System32\\bash.exe';
      }),
    /Git for Windows Bash was not found/,
  );
  assert.deepEqual(checked, [
    'C:\\Git\\bin\\bash.exe',
    'C:\\Git\\usr\\bin\\bash.exe',
  ]);
  assert.throws(() => resolveGitBash('', () => true), /was not found/);
  assert.throws(
    () =>
      resolveGitBash('git.exe\nC:\\Windows\\System32\\bash.exe', () => true),
    /was not found/,
  );
});
test('resolver requires discovery text and an explicit regular-file check', () => {
  assert.throws(() => resolveGitBash(undefined, () => true), TypeError);
  assert.throws(() => resolveGitBash('C:\\Git\\cmd\\git.exe'), TypeError);
});
