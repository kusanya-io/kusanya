import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkApexCoverage, isTestApex } from './apex-coverage.mjs';
function fixture(covered = 85, total = 100) {
  return {
    status: 0,
    result: {
      summary: {
        outcome: 'Passed',
        testsRan: 1,
        passing: 1,
        failing: 0,
        skipped: 0,
      },
      tests: [{ Outcome: 'Pass' }],
      coverage: {
        coverage: [
          { name: 'Example', totalCovered: covered, totalLines: total },
        ],
      },
    },
  };
}
test('annotation detection ignores comments and string literals in production classes', () => {
  assert.equal(
    isTestApex("/* @IsTest */ public class Demo { String label = '@IsTest'; }"),
    false,
  );
  assert.equal(isTestApex('// @isTest\npublic class Demo {}'), false);
  assert.equal(isTestApex('@IsTest private class Demo {}'), true);
});
test('accepts exact 85 percent from actual executable-line counts', () => {
  assert.equal(checkApexCoverage(fixture(), ['Example']).percentage, 85);
});
test('rejects coverage below 85 even if a display percentage rounds up', () => {
  const report = fixture(849, 1000);
  report.result.coverage.coverage[0].coveredPercent = 85;
  assert.throws(() => checkApexCoverage(report, ['Example']), /below 85/);
});
test('weights classes by executable lines rather than averaging percentages', () => {
  const report = fixture(1, 1);
  report.result.coverage.coverage.push({
    name: 'Large',
    totalCovered: 80,
    totalLines: 100,
  });
  assert.throws(
    () => checkApexCoverage(report, ['Example', 'Large']),
    /below 85/,
  );
});
test('fails closed when result, executable coverage or a source class is absent', () => {
  for (const report of [{}, { status: 0 }, { status: 1 }, fixture(0, 0)])
    assert.throws(() => checkApexCoverage(report, ['Example']));
  const report = fixture();
  delete report.result.coverage;
  assert.throws(() => checkApexCoverage(report, ['Example']));
  assert.throws(
    () => checkApexCoverage(fixture(), ['Example', 'Untested']),
    /Missing coverage/,
  );
});
test('rejects failed, skipped, incomplete, empty or contradictory tests', () => {
  for (const field of ['failing', 'skipped']) {
    const report = fixture();
    report.result.summary[field] = 1;
    assert.throws(() => checkApexCoverage(report, ['Example']));
  }
  for (const mutate of [
    (r) => {
      r.result.tests[0].Outcome = 'Fail';
    },
    (r) => {
      r.result.tests = [];
    },
    (r) => {
      r.result.summary.testsRan = 0;
    },
    (r) => {
      r.result.summary.outcome = 'InProgress';
    },
  ]) {
    const report = fixture();
    mutate(report);
    assert.throws(() => checkApexCoverage(report, ['Example']));
  }
});
test('rejects malformed counts, duplicate records and false numeric strings', () => {
  for (const covered of [-1, 101, '85', null, Number.NaN, 85.5])
    assert.throws(() => checkApexCoverage(fixture(covered), ['Example']));
  const report = fixture();
  report.result.coverage.coverage.push(report.result.coverage.coverage[0]);
  assert.throws(() => checkApexCoverage(report, ['Example']), /duplicate/);
});
