/** Synthetic local reviewer examples only; no input files, server, browser or authentication. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPrintView } from '../service/dist/src/print/render.js';
import {
  reviewerFixture,
  largeReviewerFixture,
} from '../service/dist/test/fixtures/print.js';

if (process.argv.length !== 2)
  throw new Error('Usage: node scripts/export-print-fixture.mjs');
const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(join(root, 'work'), { recursive: true });
const output = mkdtempSync(join(root, 'work', 'print-view-'));
const files = {};
for (const [name, build] of Object.entries({
  review: reviewerFixture,
  large: largeReviewerFixture,
})) {
  const { form, mappings } = build();
  const result = renderPrintView(form, mappings);
  if (!result.ok)
    throw new Error(
      `Synthetic ${name} print fixture failed: ${JSON.stringify(result.diagnostics)}`,
    );
  for (const [suffix, value] of Object.entries({
    html: result.html,
    'input.json': `${JSON.stringify({ form, mappings }, null, 2)}\n`,
  })) {
    const filename = `${name}.${suffix}`;
    writeFileSync(join(output, filename), value, {
      encoding: 'utf8',
      flag: 'wx',
    });
    files[filename] = createHash('sha256').update(value).digest('hex');
  }
}
writeFileSync(
  join(output, 'manifest.json'),
  `${JSON.stringify({ audience: 'reviewer-only', validation: 'structural-only', syntheticOnly: true, files }, null, 2)}\n`,
  { encoding: 'utf8', flag: 'wx' },
);
console.log(`Synthetic reviewer HTML and source snapshots: ${output}`);
console.log(
  'Open review.html locally and use the browser Print command. No publication or C10 claim.',
);
