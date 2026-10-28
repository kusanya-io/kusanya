/** Static, no-store browser interface over the mounted administrator APIs. */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireHardenedRequestLogging } from './http-security.js';

const interfacePath = '/admin';

const styles = `
:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #f5f7fb; color: #15233b; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; }
header { background: #173b63; color: white; padding: 1.5rem clamp(1rem, 4vw, 3rem); }
header p { margin: .35rem 0 0; color: #dbe9f7; }
main { width: min(1120px, calc(100% - 2rem)); margin: 1.5rem auto 3rem; display: grid; gap: 1rem; }
.card { background: white; border: 1px solid #d8e0ea; border-radius: .8rem; padding: 1rem; box-shadow: 0 2px 8px rgb(21 35 59 / 7%); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem; }
h1, h2 { margin: 0 0 .65rem; }
label { display: grid; gap: .35rem; font-weight: 650; }
input, select { width: 100%; border: 1px solid #9eacbe; border-radius: .45rem; padding: .65rem; font: inherit; background: white; }
button { border: 0; border-radius: .45rem; padding: .65rem .9rem; background: #176b56; color: white; font: inherit; font-weight: 700; cursor: pointer; }
button.secondary { background: #41556e; }
button:disabled { opacity: .5; cursor: not-allowed; }
form { display: grid; gap: .75rem; }
#status { min-height: 1.5rem; margin: 0; font-weight: 650; }
table { width: 100%; border-collapse: collapse; font-size: .9rem; }
th, td { text-align: left; border-bottom: 1px solid #e4e9f0; padding: .6rem .4rem; vertical-align: top; }
th { color: #405169; }
.scroll { overflow-x: auto; }
.actions { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; }
.muted { color: #5d6c80; font-size: .9rem; }
`;

const script = `
(() => {
  'use strict';
  const endpoints = Object.freeze({
    login: '/api/admin/session/login',
    csrf: '/api/admin/session/csrf',
    logout: '/api/admin/session/logout',
    attempts: '/api/admin/salesforce/publication-attempts',
    invitations: '/api/admin/administrator-invitations',
    provision: '/api/admin/administrators',
    publish: '/api/admin/salesforce/publications'
  });
  const elements = Object.freeze({
    login: document.getElementById('login-form'),
    token: document.getElementById('access-token'),
    invitationToken: document.getElementById('invitation-token'),
    invite: document.getElementById('invitation-form'),
    invitationId: document.getElementById('invitation-id'),
    invitationOutput: document.getElementById('invitation-output'),
    revokeInvitation: document.getElementById('revoke-invitation'),
    subject: document.getElementById('oidc-subject'),
    role: document.getElementById('administrator-role'),
    deprovision: document.getElementById('deprovision'),
    changeRole: document.getElementById('change-role'),
    publish: document.getElementById('publish-form'),
    formVersion: document.getElementById('form-version'),
    logout: document.getElementById('logout'),
    more: document.getElementById('more'),
    rows: document.getElementById('attempt-rows'),
    status: document.getElementById('status'),
    workspace: document.getElementById('workspace')
  });
  const clearInvitationSecret = () => {
    elements.invitationId.value = '';
    elements.invitationOutput.value = '';
  };
  let csrfToken = null;
  let nextCursor = null;
  const setStatus = (message) => { elements.status.textContent = message; };
  const fixedFailure = (response) => response.status === 401
    ? 'Authentication required.'
    : response.status === 403
      ? 'Request authorization failed.'
      : response.status === 409
          ? 'Human judgement is required before any publication retry.'
        : 'The operation could not be completed.';
  const protectedHeaders = () => Object.freeze({ 'X-CSRF-Token': csrfToken });
  const request = (url, init = {}) => fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    ...init
  });
  const cell = (row, value) => {
    const item = document.createElement('td');
    item.textContent = value === null ? '—' : String(value);
    row.append(item);
  };
  const renderAttempts = (attempts, replace) => {
    if (replace) elements.rows.replaceChildren();
    for (const attempt of attempts) {
      const row = document.createElement('tr');
      cell(row, attempt.formVersionId);
      cell(row, attempt.operatorStatus.replaceAll('_', ' '));
      cell(row, attempt.startedAt);
      cell(row, attempt.completedAt);
      cell(row, attempt.attemptId);
      elements.rows.append(row);
    }
  };
  const loadAttempts = async (replace = true) => {
    const suffix = !replace && nextCursor ? '?cursor=' + encodeURIComponent(nextCursor) : '';
    const response = await request(endpoints.attempts + suffix, { headers: protectedHeaders() });
    if (!response.ok) throw new Error(fixedFailure(response));
    const page = await response.json();
    renderAttempts(page.attempts, replace);
    nextCursor = page.nextCursor;
    elements.more.disabled = nextCursor === null;
  };
  const bootstrap = async () => {
    const response = await request(endpoints.csrf, { method: 'POST' });
    if (!response.ok) {
      csrfToken = null;
      clearInvitationSecret();
      elements.workspace.hidden = true;
      setStatus('Sign in with a short-lived Kusanya API access token.');
      return;
    }
    const body = await response.json();
    csrfToken = body.csrfToken;
    elements.workspace.hidden = false;
    setStatus('Administrator session active.');
    await loadAttempts(true);
  };
  elements.login.addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = elements.token.value;
    const invitationToken = elements.invitationToken.value;
    elements.token.value = '';
    elements.invitationToken.value = '';
    clearInvitationSecret();
    try {
      const headers = { Authorization: 'Bearer ' + token };
      const init = { method: 'POST', headers };
      if (invitationToken !== '') {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify({ invitationToken });
      }
      const response = await request(endpoints.login, {
        ...init
      });
      if (!response.ok) throw new Error(fixedFailure(response));
      await bootstrap();
    } catch (error) { setStatus(error.message); }
  });
  elements.invite.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearInvitationSecret();
    try {
      const response = await request(endpoints.invitations, {
        method: 'POST',
        headers: { ...protectedHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: elements.subject.value,
          role: elements.role.value
        })
      });
      if (!response.ok) throw new Error(fixedFailure(response));
      const invitation = await response.json();
      elements.subject.value = '';
      elements.invitationId.value = invitation.invitationId;
      elements.invitationOutput.value = invitation.invitationToken;
      setStatus('Invitation created. Copy its one-time token securely.');
    } catch (error) { setStatus(error.message); }
  });
  elements.revokeInvitation.addEventListener('click', async () => {
    try {
      const response = await request(endpoints.invitations, {
        method: 'DELETE',
        headers: { ...protectedHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ invitationId: elements.invitationId.value })
      });
      if (!response.ok) throw new Error(fixedFailure(response));
      clearInvitationSecret();
      setStatus('Invitation revoked if it was still pending.');
    } catch (error) { setStatus(error.message); }
  });
  elements.deprovision.addEventListener('click', async () => {
    try {
      const response = await request(endpoints.provision, {
        method: 'DELETE',
        headers: { ...protectedHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: elements.subject.value })
      });
      if (!response.ok) throw new Error(fixedFailure(response));
      elements.subject.value = '';
      setStatus('Operator access removed for this tenant.');
    } catch (error) { setStatus(error.message); }
  });
  elements.changeRole.addEventListener('click', async () => {
    try {
      const response = await request(endpoints.provision, {
        method: 'PATCH',
        headers: { ...protectedHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: elements.subject.value,
          role: elements.role.value
        })
      });
      if (!response.ok) throw new Error(fixedFailure(response));
      elements.subject.value = '';
      setStatus('Operator role changed for this tenant.');
    } catch (error) { setStatus(error.message); }
  });
  elements.publish.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const response = await request(endpoints.publish, {
        method: 'POST',
        headers: { ...protectedHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ formVersionId: elements.formVersion.value })
      });
      if (!response.ok) throw new Error(fixedFailure(response));
      elements.formVersion.value = '';
      setStatus('Publication request completed.');
      await loadAttempts(true);
    } catch (error) { setStatus(error.message); }
  });
  elements.more.addEventListener('click', async () => {
    try { await loadAttempts(false); }
    catch (error) { setStatus(error.message); }
  });
  elements.logout.addEventListener('click', async () => {
    clearInvitationSecret();
    try {
      const response = await request(endpoints.logout, {
        method: 'POST',
        headers: protectedHeaders()
      });
      if (!response.ok) throw new Error(fixedFailure(response));
      csrfToken = null;
      nextCursor = null;
      elements.rows.replaceChildren();
      elements.workspace.hidden = true;
      setStatus('Signed out.');
    } catch (error) { setStatus(error.message); }
  });
  bootstrap().catch(() => setStatus('The operator interface is unavailable.'));
})();
`;

const digest = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('base64');

const policy = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'none'",
  `script-src 'sha256-${digest(script)}'`,
  `style-src 'sha256-${digest(styles)}'`,
].join('; ');

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kusanya operator</title>
  <style>${styles}</style>
</head>
<body>
  <header><h1>Kusanya operator</h1><p>Tenant-bound Salesforce publication and administration</p></header>
  <main>
    <section class="card" aria-labelledby="session-title">
      <h2 id="session-title">Administrator session</h2>
      <form id="login-form" autocomplete="off">
        <label>Short-lived Kusanya API access token<input id="access-token" name="access-token" type="password" required autocomplete="off" spellcheck="false"></label>
        <label>Invitation token (first sign-in only)<input id="invitation-token" name="invitation-token" type="password" autocomplete="off" spellcheck="false"></label>
        <div class="actions"><button type="submit">Sign in</button><button id="logout" class="secondary" type="button">Sign out</button></div>
      </form>
      <p id="status" role="status" aria-live="polite"></p>
    </section>
    <div id="workspace" hidden>
      <div class="grid">
        <section class="card" aria-labelledby="provision-title">
          <h2 id="provision-title">Manage tenant operators</h2>
          <p class="muted">Issue a one-time invitation for the configured OIDC subject. The subject receives no authority until accepting it during sign-in. Role changes take effect on the next request.</p>
          <form id="invitation-form">
            <label>OIDC subject<input id="oidc-subject" name="subject" required maxlength="512" autocomplete="off"></label>
            <label>Role<select id="administrator-role" name="role"><option value="reviewer">Reviewer</option><option value="publisher">Publisher</option><option value="administrator">Administrator</option></select></label>
            <div class="actions"><button type="submit">Create invitation</button><button id="change-role" class="secondary" type="button">Change existing role</button><button id="deprovision" class="secondary" type="button">Remove existing operator</button></div>
          </form>
          <label>Invitation ID<input id="invitation-id" autocomplete="off" spellcheck="false"></label>
          <label>One-time invitation token<input id="invitation-output" readonly autocomplete="off" spellcheck="false"></label>
          <p><button id="revoke-invitation" class="secondary" type="button">Revoke invitation</button></p>
        </section>
        <section class="card" aria-labelledby="publish-title">
          <h2 id="publish-title">Publish a form version</h2>
          <form id="publish-form">
            <label>Salesforce Form Version ID<input id="form-version" name="form-version" required pattern="[A-Za-z0-9]{15}([A-Za-z0-9]{3})?" autocomplete="off"></label>
            <button type="submit">Publish</button>
          </form>
        </section>
      </div>
      <section class="card" aria-labelledby="attempts-title">
        <h2 id="attempts-title">Publication attempts</h2>
        <div class="scroll"><table><thead><tr><th>Form version</th><th>Status</th><th>Started</th><th>Completed</th><th>Attempt</th></tr></thead><tbody id="attempt-rows"></tbody></table></div>
        <p><button id="more" class="secondary" type="button" disabled>Load older attempts</button></p>
      </section>
    </div>
  </main>
  <script>${script}</script>
</body>
</html>`;

/** Mount a static shell; every data or mutation request still crosses the APIs. */
export function registerOperatorInterfaceRoutes(app: FastifyInstance): void {
  requireHardenedRequestLogging(app);
  app.get(interfacePath, async (_request, reply) => {
    reply.headers({
      'Content-Security-Policy': policy,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy':
        'camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });
}

export const operatorInterfaceRoutePaths = Object.freeze({
  interface: interfacePath,
});
