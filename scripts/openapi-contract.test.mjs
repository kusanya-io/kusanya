import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const contractUrl = new URL('../docs/openapi.yaml', import.meta.url);

void test('operator OpenAPI remains least-data and documents the lifecycle surface', async () => {
  const contract = await readFile(contractUrl, 'utf8');
  const attemptPath = contract.match(
    /  \/api\/admin\/salesforce\/publication-attempts:\n([\s\S]*?)\ncomponents:/,
  )?.[1];
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
  for (const status of statuses)
    assert.match(summary, new RegExp(`^            - ${status}$`, 'm'));
  assert.equal((summary.match(/^            - /gm) ?? []).length, 7);

  const administratorPath = contract.match(
    /  \/api\/admin\/administrators:\n([\s\S]*?)\n  \/api\/admin\/administrator-invitations:/,
  )?.[1];
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

  const invitationPath = contract.match(
    /  \/api\/admin\/administrator-invitations:\n([\s\S]*?)\n  \/api\/admin\/salesforce\/publications:/,
  )?.[1];
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

  const loginPath = contract.match(
    /  \/api\/admin\/session\/login:\n([\s\S]*?)\n  \/api\/admin\/session\/csrf:/,
  )?.[1];
  assert.ok(loginPath, 'administrator login path is documented');
  assert.match(loginPath, /required: \[invitationToken\]/);
  assert.doesNotMatch(loginPath, /tenantId|actorId|role/);
});
