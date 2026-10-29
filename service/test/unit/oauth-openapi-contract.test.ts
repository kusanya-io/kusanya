import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const contractUrl = new URL('../../../../docs/openapi.yaml', import.meta.url);

void test('mounted Salesforce OAuth contract exposes no tenant selector or credential', async () => {
  const contract = await readFile(contractUrl, 'utf8');
  const authorizationPath = contract.match(
    / {2}\/api\/admin\/salesforce\/authorization:\n([\s\S]*?)\n {2}\/api\/admin\/salesforce\/callback:/,
  )?.[1];
  assert.ok(authorizationPath, 'Salesforce authorization start is documented');
  assert.match(authorizationPath, /^ {4}post:$/m);
  assert.match(
    authorizationPath,
    /security: \[\{ administratorSession: \[\], csrfToken: \[\] \}\]/,
  );
  assert.doesNotMatch(
    authorizationPath,
    /tenantId|actorId|salesforceOrgId|authorizationOrigin|namespacePrefix|refreshToken/,
  );

  const callbackPath = contract.match(
    / {2}\/api\/admin\/salesforce\/callback:\n([\s\S]*?)\n {2}\/api\/admin\/salesforce\/publications:/,
  )?.[1];
  assert.ok(callbackPath, 'Salesforce authorization callback is documented');
  assert.match(callbackPath, /^ {4}get:$/m);
  assert.match(
    callbackPath,
    /security: \[\{ administratorSession: \[\], oauthBrowserBinding: \[\] \}\]/,
  );
  assert.match(callbackPath, /status: \{ type: string, const: connected \}/);
  assert.doesNotMatch(
    callbackPath,
    /tenantId|actorId|salesforceOrgId|namespacePrefix|refreshToken|accessToken/,
  );
});
