import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

const failureKinds = new Set([
  'test-failure',
  'coverage-below-threshold',
  'evidence-incomplete',
  'configuration-invalid',
]);

export class ApexVerificationError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'ApexVerificationError';
    this.kind = failureKinds.has(kind) ? kind : 'configuration-invalid';
  }
}

const refuse = (kind, message) => {
  throw new ApexVerificationError(kind, message);
};

// CLI percentages are rounded; enforce C11 using executable-line counts.
export function checkApexCoverage(report, expectedClasses) {
  if (report?.status !== 0)
    refuse('evidence-incomplete', 'Salesforce CLI did not succeed.');
  const result = report.result;
  const summary = result?.summary;
  if (
    !summary ||
    !integer(summary.testsRan) ||
    !integer(summary.passing) ||
    !integer(summary.failing) ||
    !integer(summary.skipped)
  )
    refuse(
      'evidence-incomplete',
      'Apex test summary evidence is missing or malformed.',
    );
  if (
    summary.outcome !== 'Passed' ||
    summary.testsRan === 0 ||
    summary.failing !== 0 ||
    summary.skipped !== 0
  )
    refuse(
      'test-failure',
      'Apex tests must complete with at least one pass and no failures or skips.',
    );
  if (summary.passing !== summary.testsRan)
    refuse(
      'evidence-incomplete',
      'Apex test summary counts are contradictory.',
    );
  if (!Array.isArray(result.tests) || result.tests.length !== summary.testsRan)
    refuse(
      'evidence-incomplete',
      'Detailed Apex test results are missing or incomplete.',
    );
  if (result.tests.some((test) => test?.Outcome !== 'Pass'))
    refuse('test-failure', 'Detailed Apex test results are unsuccessful.');
  const coverage = result.coverage?.coverage;
  if (!Array.isArray(expectedClasses) || expectedClasses.length === 0)
    refuse(
      'configuration-invalid',
      'At least one source class or trigger is required.',
    );
  if (!Array.isArray(coverage) || coverage.length === 0)
    refuse(
      'evidence-incomplete',
      'Executable Apex coverage evidence and source class names are required.',
    );
  const names = new Set();
  let covered = 0;
  let total = 0;
  for (const entry of coverage) {
    if (
      typeof entry.name !== 'string' ||
      !entry.name ||
      names.has(entry.name) ||
      !integer(entry.totalLines) ||
      !integer(entry.totalCovered) ||
      entry.totalCovered > entry.totalLines
    )
      refuse(
        'evidence-incomplete',
        'Malformed or duplicate Apex coverage record.',
      );
    names.add(entry.name);
    if (expectedClasses.includes(entry.name)) {
      covered += entry.totalCovered;
      total += entry.totalLines;
    }
  }
  for (const name of expectedClasses)
    if (!names.has(name))
      refuse(
        'evidence-incomplete',
        `Missing coverage for source class or trigger: ${name}`,
      );
  if (total === 0)
    refuse(
      'evidence-incomplete',
      'Apex coverage contains no executable source lines.',
    );
  if (covered * 100 < total * 85)
    refuse(
      'coverage-below-threshold',
      `Apex coverage ${covered}/${total} executable lines is below 85%.`,
    );
  return {
    tests: summary.testsRan,
    covered,
    total,
    percentage: (covered * 100) / total,
  };
}

export function isTestApex(source) {
  const declarations = source.replace(
    /'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    '',
  );
  return /@isTest\b/i.test(declarations);
}
export function productionApexNames(directory) {
  const names = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) names.push(...productionApexNames(path));
    else if (/\.(cls|trigger)$/.test(entry.name)) {
      const source = readFileSync(path, 'utf8');
      if (!isTestApex(source))
        names.push(entry.name.replace(/\.(cls|trigger)$/, ''));
    }
  }
  return names;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (!process.argv[2])
      throw new Error(
        'Usage: node scripts/apex-coverage.mjs <sf-test-result.json>',
      );
    const source = fileURLToPath(
      new URL('../salesforce/force-app', import.meta.url),
    );
    const outcome = checkApexCoverage(
      JSON.parse(readFileSync(process.argv[2], 'utf8')),
      productionApexNames(source),
    );
    console.log(
      `Apex: ${outcome.tests} passed; ${outcome.covered}/${outcome.total} lines covered (${outcome.percentage.toFixed(2)}%).`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
