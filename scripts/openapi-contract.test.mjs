import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const contractUrl = new URL('../docs/openapi.yaml', import.meta.url);

function pathBlock(contract, path) {
  const lines = contract.split(/\r?\n/);
  const start = lines.indexOf(`  ${path}:`);
  if (start === -1) return undefined;
  let end = start + 1;
  while (
    end < lines.length &&
    !/^ {2}\//.test(lines[end]) &&
    lines[end] !== 'components:'
  )
    end++;
  return lines.slice(start + 1, end).join('\n');
}

void test('operator OpenAPI remains least-data and documents the lifecycle surface', async () => {
  const contract = await readFile(contractUrl, 'utf8');
  const attemptPath = pathBlock(
    contract,
    '/api/admin/salesforce/publication-attempts',
  );
  assert.ok(attemptPath, 'publication attempt path is documented');
  for (const forbidden of [
    'actorId',
    'tenantId',
    'salesforceOrgId',
    'publicationDigest',
    'xformVersionId',
    'xlsformVersionId',
    'failureCode',
    'salesforceRequestCount',
  ])
    assert.doesNotMatch(attemptPath, new RegExp(`\\b${forbidden}\\b`));

  const summary = contract.match(
    /    PublicationAttemptSummary:\n([\s\S]*)$/,
  )?.[1];
  assert.ok(summary, 'publication attempt summary is documented');
  const expectedFields = [
    'attemptId',
    'formVersionId',
    'operatorStatus',
    'startedAt',
    'completedAt',
    'reconciledAt',
    'retryOfAttemptId',
    'retryEligible',
    'artifactCleanupStatus',
    'artifactCleanupEligible',
  ];
  for (const field of expectedFields)
    assert.match(summary, new RegExp(`^        ${field}:`, 'm'));
  for (const forbidden of ['actorId', 'tenantId', 'salesforceOrgId'])
    assert.doesNotMatch(summary, new RegExp(`^        ${forbidden}:`, 'm'));

  const statuses = [
    'human_judgement_required_unresolved',
    'human_judgement_required_indeterminate',
    'published',
    'rejected',
    'published_confirmed',
    'unlinked_artifacts_confirmed',
    'artifacts_missing_confirmed',
  ];
  const operatorStatus = summary.match(
    /^        operatorStatus:\n([\s\S]*?)(?=^        [A-Za-z][A-Za-z0-9]*:)/m,
  )?.[1];
  assert.ok(operatorStatus, 'operatorStatus schema is documented');
  for (const status of statuses)
    assert.match(operatorStatus, new RegExp(`^            - ${status}$`, 'm'));
  assert.equal((operatorStatus.match(/^            - /gm) ?? []).length, 7);

  const cleanupPath = pathBlock(
    contract,
    '/api/admin/salesforce/publication-artifact-cleanups',
  );
  assert.ok(cleanupPath, 'publication artifact cleanup path is documented');
  assert.match(cleanupPath, /^    post:$/m);
  assert.doesNotMatch(cleanupPath, /^    (?:get|put|patch|delete):$/m);
  assert.match(cleanupPath, /required: \[attemptId\]/);
  assert.doesNotMatch(
    cleanupPath,
    /tenantId|actorId|salesforceOrgId|formVersionId|publicationDigest|xformVersionId|xlsformVersionId/,
  );

  const administratorPath = pathBlock(contract, '/api/admin/administrators');
  assert.ok(administratorPath, 'administrator lifecycle path is documented');
  assert.doesNotMatch(administratorPath, /^    post:$/m);
  assert.match(administratorPath, /^    patch:$/m);
  assert.match(administratorPath, /^    delete:$/m);
  assert.equal(
    (
      administratorPath.match(
        /^                  enum: \[administrator, publisher, reviewer\]$/gm,
      ) ?? []
    ).length,
    1,
  );
  assert.doesNotMatch(
    administratorPath,
    /tenantId|actorId|salesforceOrgId|authorizationOrigin|namespacePrefix/,
  );

  const invitationPath = pathBlock(
    contract,
    '/api/admin/administrator-invitations',
  );
  assert.ok(invitationPath, 'administrator invitation path is documented');
  assert.match(invitationPath, /^    post:$/m);
  assert.match(invitationPath, /^    delete:$/m);
  assert.doesNotMatch(invitationPath, /^    patch:$/m);
  for (const field of ['invitationId', 'invitationToken', 'expiresInSeconds'])
    assert.match(invitationPath, new RegExp(`\\b${field}\\b`));
  assert.doesNotMatch(
    invitationPath,
    /tenantId|actorId|salesforceOrgId|authorizationOrigin|namespacePrefix/,
  );

  const loginPath = pathBlock(contract, '/api/admin/session/login');
  assert.ok(loginPath, 'administrator login path is documented');
  assert.match(loginPath, /required: \[invitationToken\]/);
  assert.doesNotMatch(loginPath, /tenantId|actorId|role/);

  const authorizationPath = pathBlock(
    contract,
    '/api/admin/salesforce/authorization',
  );
  assert.ok(authorizationPath, 'Salesforce authorization start is documented');
  assert.match(authorizationPath, /^ {4}post:$/m);
  assert.doesNotMatch(authorizationPath, /^ {4}(?:get|put|patch|delete):$/m);
  assert.match(
    authorizationPath,
    /security: \[\{ administratorSession: \[\], csrfToken: \[\] \}\]/,
  );
  assert.doesNotMatch(authorizationPath, /in: query|requestBody:/);
  assert.doesNotMatch(
    authorizationPath,
    /tenantId|actorId|salesforceOrgId|authorizationOrigin|namespacePrefix|refreshToken|accessToken/,
  );

  const callbackPath = pathBlock(contract, '/api/admin/salesforce/callback');
  assert.ok(callbackPath, 'Salesforce authorization callback is documented');
  assert.match(callbackPath, /^ {4}get:$/m);
  assert.doesNotMatch(callbackPath, /^ {4}(?:post|put|patch|delete):$/m);
  assert.match(
    callbackPath,
    /security: \[\{ administratorSession: \[\], oauthBrowserBinding: \[\] \}\]/,
  );
  for (const parameter of ['state', 'code', 'error', 'error_description'])
    assert.match(callbackPath, new RegExp(`^ {8}- name: ${parameter}$`, 'm'));
  assert.match(callbackPath, /status: \{ type: string, const: connected \}/);
  assert.doesNotMatch(callbackPath, /requestBody:/);
  assert.doesNotMatch(
    callbackPath,
    /tenantId|actorId|salesforceOrgId|namespacePrefix|refreshToken|accessToken/,
  );

  const disconnectPath = pathBlock(
    contract,
    '/api/admin/salesforce/connection/disconnect',
  );
  assert.ok(disconnectPath, 'Salesforce disconnect is documented');
  assert.match(disconnectPath, /^ {4}post:$/m);
  assert.doesNotMatch(disconnectPath, /^ {4}(?:get|put|patch|delete):$/m);
  assert.doesNotMatch(disconnectPath, /in: query|requestBody:/);
  assert.doesNotMatch(
    disconnectPath,
    /tenantId|actorId|salesforceOrgId|authorizationOrigin|namespacePrefix|refreshToken|accessToken|^\s+force:/m,
  );

  const rebindPath = pathBlock(
    contract,
    '/api/admin/salesforce/connection/rebind',
  );
  assert.ok(rebindPath, 'Salesforce rebind is documented');
  assert.match(rebindPath, /^ {4}post:$/m);
  assert.doesNotMatch(rebindPath, /^ {4}(?:get|put|patch|delete):$/m);
  assert.match(
    rebindPath,
    /required: \[salesforceOrgId, authorizationOrigin, namespacePrefix\]/,
  );
  assert.doesNotMatch(
    rebindPath,
    /tenantId|actorId|refreshToken|accessToken|instanceOrigin|^\s+force:/m,
  );
});
