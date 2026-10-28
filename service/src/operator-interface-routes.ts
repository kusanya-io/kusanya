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
input { width: 100%; border: 1px solid #9eacbe; border-radius: .45rem; padding: .65rem; font: inherit; }
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
    provision: '/api/admin/administrators',
    publish: '/api/admin/salesforce/publications'
  });
  const elements = Object.freeze({
    login: document.getElementById('login-form'),
    token: document.getElementById('access-token'),
    provision: document.getElementById('provision-form'),
    subject: document.getElementById('oidc-subject'),
    deprovision: document.getElementById('deprovision'),
    publish: document.getElementById('publish-form'),
    formVersion: document.getElementById('form-version'),
    logout: document.getElementById('logout'),
    more: document.getElementById('more'),
    rows: document.getElementById('attempt-rows'),
    status: document.getElementById('status'),
    workspace: document.getElementById('workspace')
  });
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
    elements.token.value = '';
    try {
      const response = await request(endpoints.login, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token }
      });
      if (!response.ok) throw new Error(fixedFailure(response));
      await bootstrap();
    } catch (error) { setStatus(error.message); }
  });
  elements.provision.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const response = await request(endpoints.provision, {
        method: 'POST',
        headers: { ...protectedHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: elements.subject.value })
      });
      if (!response.ok) throw new Error(fixedFailure(response));
      elements.subject.value = '';
      setStatus('Administrator enrolled for this tenant.');
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
      setStatus('Administrator access removed for this tenant.');
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
        <div class="actions"><button type="submit">Sign in</button><button id="logout" class="secondary" type="button">Sign out</button></div>
      </form>
      <p id="status" role="status" aria-live="polite"></p>
    </section>
    <div id="workspace" hidden>
      <div class="grid">
        <section class="card" aria-labelledby="provision-title">
          <h2 id="provision-title">Enroll an administrator</h2>
          <p class="muted">The OIDC subject is mapped by the configured identity provider and can join only this tenant.</p>
          <form id="provision-form">
            <label>OIDC subject<input id="oidc-subject" name="subject" required maxlength="512" autocomplete="off"></label>
            <div class="actions"><button type="submit">Enroll administrator</button><button id="deprovision" class="secondary" type="button">Remove administrator</button></div>
          </form>
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
