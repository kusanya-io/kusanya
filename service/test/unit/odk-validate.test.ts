import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  createOdkValidateValidator,
  odkValidate120Sha256,
  runBoundedProcess,
} from '../../src/publication/odk-validate.js';

void test('publishes the reviewed ODK Validate 1.20.0 pin', () => {
  assert.equal(
    odkValidate120Sha256,
    '92756ea4aed195355a07e5572f025f0921a31282387a870ae63e1f5cdf37e0c3',
  );
});

void test('refuses relative validator configuration without process execution', async () => {
  const validate = createOdkValidateValidator({
    javaExecutable: 'java',
    jarPath: 'ODK-Validate-v1.20.0.jar',
  });
  assert.deepEqual(await validate('<data/>'), {
    ok: false,
    diagnostic: {
      code: 'PUBLICATION_VALIDATOR_CONFIGURATION',
      location: 'validator',
    },
  });
});

void test('refuses a non-reviewed jar without exposing its bytes or path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kusanya-odk-test-'));
  const jarPath = join(directory, 'unreviewed.jar');
  try {
    await writeFile(jarPath, 'JAR_SECRET');
    const validate = createOdkValidateValidator({
      javaExecutable: process.execPath,
      jarPath,
    });
    const result = await validate('<data>XML_SECRET</data>');
    assert.deepEqual(result, {
      ok: false,
      diagnostic: {
        code: 'PUBLICATION_VALIDATOR_PIN',
        location: 'validator',
      },
    });
    assert.equal(JSON.stringify(result).includes(directory), false);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
    assert.ok(Object.isFrozen(result));
    if (!result.ok) assert.ok(Object.isFrozen(result.diagnostic));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('converts missing reviewed-tool paths into a bounded failure', async () => {
  const validate = createOdkValidateValidator({
    javaExecutable: process.execPath,
    jarPath: join(tmpdir(), 'kusanya-missing-odk-validate.jar'),
  });
  assert.deepEqual(await validate('<data/>'), {
    ok: false,
    diagnostic: {
      code: 'PUBLICATION_VALIDATOR_FAILURE',
      location: 'validator',
    },
  });
});

void test('bounded runner distinguishes exits without retaining child output', async () => {
  const cwd = tmpdir();
  const success = await runBoundedProcess({
    executable: process.execPath,
    arguments: ['-e', "process.stdout.write('OUTPUT_SECRET')"],
    cwd,
    timeoutMs: 5_000,
    maxOutputBytes: 1_024,
  });
  const refusal = await runBoundedProcess({
    executable: process.execPath,
    arguments: ['-e', "process.stderr.write('ERROR_SECRET');process.exit(7)"],
    cwd,
    timeoutMs: 5_000,
    maxOutputBytes: 1_024,
  });
  assert.equal(success, 'exit-zero');
  assert.equal(refusal, 'exit-nonzero');
  assert.equal(JSON.stringify({ success, refusal }).includes('SECRET'), false);
});

void test('bounded runner terminates timeout and output overflow', async () => {
  const cwd = tmpdir();
  const started = Date.now();
  const timedOut = await runBoundedProcess({
    executable: process.execPath,
    arguments: ['-e', 'setInterval(() => {}, 1000)'],
    cwd,
    timeoutMs: 25,
    maxOutputBytes: 1_024,
  });
  const overflow = await runBoundedProcess({
    executable: process.execPath,
    arguments: ['-e', "process.stdout.write('x'.repeat(4096))"],
    cwd,
    timeoutMs: 5_000,
    maxOutputBytes: 32,
  });
  assert.equal(timedOut, 'infrastructure');
  assert.equal(overflow, 'infrastructure');
  assert.ok(Date.now() - started < 5_000);
});

void test('bounded runner rejects unsafe limits and missing executables', async () => {
  const request = {
    executable: process.execPath,
    arguments: ['-e', 'process.exit(0)'],
    cwd: tmpdir(),
    timeoutMs: 0,
    maxOutputBytes: 1,
  };
  assert.equal(await runBoundedProcess(request), 'infrastructure');
  assert.equal(
    await runBoundedProcess({
      ...request,
      executable: join(tmpdir(), 'kusanya-missing-java'),
      timeoutMs: 100,
    }),
    'infrastructure',
  );
});
