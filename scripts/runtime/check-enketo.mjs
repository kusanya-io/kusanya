/** Optional synthetic engine probe; no server/auth/Salesforce. Page requests are blocked. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import {
  compiledFixtures,
  createOutput,
  exportFixtures,
} from './export-fixtures.mjs';

const [chrome, ...extra] = process.argv.slice(2);
if (
  !chrome ||
  !isAbsolute(chrome) ||
  extra.length ||
  process.versions.node.split('.')[0] !== '22'
) {
  throw new Error(
    'Usage under Node 22: node scripts/runtime/check-enketo.mjs <absolute-Chromium-executable>',
  );
}
const directory = fileURLToPath(new URL('./', import.meta.url));
for (const [name, version] of Object.entries({
  'enketo-core': '9.0.1',
  'enketo-transformer': '4.2.0',
  esbuild: '0.28.2',
  'playwright-core': '1.63.0',
})) {
  assert.equal(
    JSON.parse(
      readFileSync(join(directory, 'node_modules', name, 'package.json')),
    ).version,
    version,
  );
}
const output = createOutput('runtime-enketo-');
const fixtures = compiledFixtures();
const manifest = exportFixtures(output, fixtures);
const bundled = await build({
  absWorkingDir: directory,
  entryPoints: ['enketo-browser.js'],
  bundle: true,
  write: false,
  platform: 'browser',
  // Browser transform only. No native Node libxslt fallback is installed or permitted.
  external: ['libxslt'],
  loader: { '.html': 'text' },
});
const bundle = bundled.outputFiles[0].text;
const childEnvironment = Object.fromEntries(
  ['SystemRoot', 'WINDIR', 'PATH', 'LANG', 'LC_ALL']
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
);
const context = await chromium.launchPersistentContext(
  join(output, 'profile'),
  {
    executablePath: chrome,
    headless: true,
    serviceWorkers: 'block',
    timeout: 30_000,
    env: { ...childEnvironment, TEMP: output, TMP: output },
    args: ['--disable-background-networking', '--disable-component-update'],
  },
);
const watchdog = setTimeout(() => {
  void context.close();
}, 60_000);
const browserErrors = [];
let blockedRequests = 0;
const results = [];
try {
  context.setDefaultTimeout(5_000);
  await context.route('**/*', (route) => {
    blockedRequests++;
    return route.abort();
  });
  const version = context.browser().version();
  async function open(xml, saved) {
    const page = await context.newPage();
    page.on('pageerror', (error) => browserErrors.push(error.message));
    await page.setContent(
      '<!doctype html><html lang="en"><head><meta charset="UTF-8"></head><body></body></html>',
    );
    await page.addScriptTag({ content: bundle });
    const errors = await page.evaluate(
      ({ xform, instance }) => window.kusanyaLoad(xform, instance),
      { xform: xml, instance: saved },
    );
    return { page, errors };
  }
  const snapshot = (page, kind) =>
    page.evaluate((k) => window.kusanyaSnapshot(k), kind);
  async function change(page, path, index, value) {
    const input = page.locator(`input[name="${path}"]`).nth(index);
    await input.fill(value);
    await input.blur();
  }
  for (const [kind, xml] of Object.entries(fixtures)) {
    let { page, errors } = await open(xml);
    assert.deepEqual(errors, [], `${kind}: no initialization errors`);
    const first = await snapshot(page, kind);
    assert.deepEqual(first.counts, [0, 0]);
    assert.deepEqual(first.domCounts, [0, 0]);
    assert.deepEqual(
      first.secondaryCounts,
      kind === 'nested' ? [3, 3] : [1, 1],
    );
    assert.equal(first.onceCount, 1);
    assert.equal(first.authorNoteLeaked, false);
    assert.equal(first.instanceIds.length, 1);
    assert.match(first.instanceIds[0], /^uuid:[0-9a-f-]{36}$/i);
    const countPath =
      kind === 'nested'
        ? '/data/families/member_count'
        : '/data/households/settings/member_limit';
    for (const [index, value] of ['2', '3'].entries())
      await change(page, countPath, index, value);
    let positive = await snapshot(page, kind);
    assert.deepEqual(positive.counts, [2, 3]);
    assert.deepEqual(positive.domCounts, [2, 3]);
    if (kind === 'section') {
      await change(page, '/data/root_count', 0, '3');
      positive = await snapshot(page, kind);
      assert.deepEqual(positive.secondaryCounts, [3, 3]);
      assert.deepEqual(positive.counts, [2, 3]);
    }
    const texts = page.locator('input[type="text"]');
    for (let index = 0; index < (await texts.count()); index++) {
      await texts.nth(index).fill(`synthetic-${index}`);
      await texts.nth(index).blur();
    }
    const answered = await snapshot(page, kind);
    assert.equal(answered.authorNoteLeaked, false);
    assert.deepEqual(answered.instanceIds, first.instanceIds);
    assert.equal(answered.answers.flat().length, 11);
    assert.equal(new Set(answered.answers.flat()).size, 11);
    writeFileSync(join(output, `${kind}-draft.xml`), answered.xml, {
      flag: 'wx',
    });
    await page.close();
    ({ page, errors } = await open(xml, answered.xml));
    assert.deepEqual(errors, []);
    const resumed = await snapshot(page, kind);
    assert.deepEqual(resumed.counts, [2, 3]);
    assert.deepEqual(resumed.domCounts, [2, 3]);
    assert.deepEqual(resumed.answers, answered.answers);
    assert.equal(resumed.onceValue, answered.onceValue);
    assert.deepEqual(resumed.instanceIds, answered.instanceIds);
    await change(page, countPath, 0, '1');
    const reduced = await snapshot(page, kind);
    assert.deepEqual(reduced.counts, [1, 3]);
    assert.deepEqual(reduced.domCounts, [1, 3]);
    assert.equal(reduced.answers.flat().length, 10);
    assert.deepEqual(reduced.answers[1], answered.answers[1]);
    assert.deepEqual(reduced.answers[0], [
      answered.answers[0][0],
      ...answered.answers[0].slice(2),
    ]);
    assert.equal(reduced.onceValue, answered.onceValue);
    assert.deepEqual(reduced.instanceIds, answered.instanceIds);
    await page.close();
    ({ page, errors } = await open(xml, reduced.xml));
    assert.deepEqual(errors, []);
    const reducedReload = await snapshot(page, kind);
    assert.deepEqual(reducedReload.counts, [1, 3]);
    assert.deepEqual(reducedReload.answers, reduced.answers);
    assert.equal(reducedReload.onceValue, reduced.onceValue);
    assert.deepEqual(reducedReload.instanceIds, reduced.instanceIds);
    await page.close();
    ({ page, errors } = await open(xml));
    assert.deepEqual(errors, []);
    const independent = await snapshot(page, kind);
    assert.notDeepEqual(
      independent.instanceIds,
      first.instanceIds,
      'A new instance needs a distinct ID',
    );
    assert.deepEqual(independent.counts, [0, 0]);
    await page.close();
    results.push({
      fixture: kind,
      initial: [0, 0],
      distinct: [2, 3],
      answersPreservedOnReload: 11,
      instanceIdPreserved: true,
      reduction: [1, 3],
      reductionRemovesAnsweredRow: true,
    });
    console.log(
      `${kind}: zero -> [2,3], 11 answers and ID preserved on reload; decrease removes one answered row`,
    );
  }
  const wrong = fixtures.nested.replace(
    'jr:count="../member_count"',
    'jr:count="../../_ksny_count_families"',
  );
  assert.notEqual(wrong, fixtures.nested);
  let negative = await open(wrong);
  assert.deepEqual(negative.errors, []);
  assert.deepEqual((await snapshot(negative.page, 'nested')).counts, [2, 2]);
  await negative.page.close();
  const oldMetadata = fixtures.nested
    .replaceAll('orx:meta', 'meta')
    .replaceAll('orx:instanceID', 'instanceID');
  assert.notEqual(oldMetadata, fixtures.nested);
  negative = await open(oldMetadata);
  assert.ok(
    negative.errors.some((error) => error.includes('Invalid XML')),
    'Unqualified-metadata negative control must fail XML initialization',
  );
  await negative.page.close();
  assert.deepEqual(browserErrors, [], 'No uncaught page errors');
  assert.equal(
    blockedRequests,
    0,
    'The fixture must not attempt any network request',
  );
  const report = {
    status: 'passed',
    engine: 'enketo-core@9.0.1',
    transformer: '4.2.0',
    node: process.versions.node,
    browser: version,
    fixtures: manifest.files,
    results,
    negativeControls: ['wrong-count-context', 'unqualified-metadata'],
    blockedRequests,
    collectUiTested: false,
    acceptanceTestsClaimed: [],
  };
  writeFileSync(
    join(output, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: 'wx' },
  );
  console.log(`Enketo runtime report: ${output}`);
  console.log(
    'Synthetic engine checks only; no Collect UI, C10 or deployed-server claim.',
  );
} finally {
  clearTimeout(watchdog);
  await context.close();
}
