'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadServer, raw, login, fakeDesktop } = require('./helpers');

const GITHUB = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'secret', SESSION_SECRET: 'test-secret' };
const DESKTOP_PORT = 39611;

function instance(overrides = {}) {
  return {
    id: 'inst1', name: 'test', slug: 'test-inst1', image: 'kasmweb/core:1',
    password: 'SuperSecretVncPw', hostPort: DESKTOP_PORT, internalPort: '6901/tcp',
    networkMode: 'bridge', extraEnv: [], binds: [], persistentProfile: false,
    containerId: 'abc123', status: 'running', ownerLogin: 'octocat', ...overrides,
  };
}

const PROXY_ENV = { ...GITHUB, GITHUB_ALLOWED_USERS: 'octocat', PROXY_TARGET_HOST: '127.0.0.1', PROXY_UPSTREAM_HTTPS: 'false' };

test('the manager session cookie never reaches a desktop container', async (t) => {
  const desktop = fakeDesktop(DESKTOP_PORT);
  await desktop.ready;
  const app = loadServer(PROXY_ENV, { instances: [instance()] });
  t.after(async () => { await app.close(); await desktop.close(); });
  await app.ready;

  const { session } = await login(app.port());
  await raw(app.port(), `/${DESKTOP_PORT}/vnc.html`, {
    headers: { Cookie: `kasm_session=${session}; theme=dark` },
  });

  const forwarded = desktop.received.headers.cookie || '';
  assert.ok(!forwarded.includes(session), 'the session token leaked to the desktop');
  assert.ok(!forwarded.includes('kasm_session'), 'the session cookie name leaked to the desktop');
  assert.ok(forwarded.includes('theme=dark'), 'unrelated cookies should still pass through');
});

test('a rewritten response is framed exactly once', async (t) => {
  const desktop = fakeDesktop(DESKTOP_PORT);
  await desktop.ready;
  const app = loadServer(PROXY_ENV, { instances: [instance()] });
  t.after(async () => { await app.close(); await desktop.close(); });
  await app.ready;

  const { session } = await login(app.port());
  const res = await raw(app.port(), `/${DESKTOP_PORT}/vnc.html`, {
    headers: { Cookie: `kasm_session=${session}` },
  });

  const head = res.head.toLowerCase();
  assert.equal(res.status, 200);
  assert.ok(!head.includes('transfer-encoding'), 'Transfer-Encoding must not survive a rewrite');
  assert.equal((head.match(/^content-length:/gm) || []).length, 1, 'exactly one Content-Length');
  assert.equal((head.match(/^content-type:/gm) || []).length, 1, 'exactly one Content-Type');
  assert.ok(res.body.includes(`/${DESKTOP_PORT}/app.js`), 'body should still be path-rewritten');
});

test('an unauthenticated proxy request never reaches the desktop', async (t) => {
  const desktop = fakeDesktop(DESKTOP_PORT);
  await desktop.ready;
  const app = loadServer(PROXY_ENV, { instances: [instance()] });
  t.after(async () => { await app.close(); await desktop.close(); });
  await app.ready;

  delete desktop.received.headers;
  const res = await raw(app.port(), `/${DESKTOP_PORT}/vnc.html`);
  assert.equal(res.status, 302);
  assert.equal(desktop.received.headers, undefined);
});

test('a desktop owned by somebody else is not proxied', async (t) => {
  const desktop = fakeDesktop(DESKTOP_PORT);
  await desktop.ready;
  const app = loadServer(
    { ...PROXY_ENV, GITHUB_ADMIN_USERS: 'someone-else' },
    { instances: [instance({ ownerLogin: 'another-user' })] },
  );
  t.after(async () => { await app.close(); await desktop.close(); });
  await app.ready;

  const { session } = await login(app.port());
  const res = await raw(app.port(), `/${DESKTOP_PORT}/vnc.html`, { headers: { Cookie: `kasm_session=${session}` } });
  assert.equal(res.status, 404);
});

test('hostname mode proxies by Host header without rewriting the body', async (t) => {
  const desktop = fakeDesktop(DESKTOP_PORT);
  await desktop.ready;
  const app = loadServer(
    { ...PROXY_ENV, DESKTOP_HOSTNAME_TEMPLATE: 'desktop-{port}.example.com' },
    { instances: [instance()] },
  );
  t.after(async () => { await app.close(); await desktop.close(); });
  await app.ready;

  const { session } = await login(app.port());
  const res = await raw(app.port(), '/vnc.html', {
    headers: { Host: `desktop-${DESKTOP_PORT}.example.com`, Cookie: `kasm_session=${session}` },
  });

  assert.equal(res.status, 200);
  assert.equal(desktop.received.url, '/vnc.html', 'the path must be passed through untouched');
  assert.ok(res.body.includes('href="/app.js"'), 'hostname mode must not rewrite paths');
  assert.ok(!(desktop.received.headers.cookie || '').includes('kasm_session'));
});

test('hostnameToPort only matches the configured template', () => {
  const app = loadServer({ DESKTOP_HOSTNAME_TEMPLATE: 'desktop-{port}.example.com' });
  const { hostnameToPort } = app.mod;
  assert.equal(hostnameToPort('desktop-6901.example.com'), 6901);
  assert.equal(hostnameToPort('desktop-abc.example.com'), null);
  assert.equal(hostnameToPort('evil-6901.example.com'), null);
  assert.equal(hostnameToPort('desktop-6901.example.com.evil.net'), null);
  return app.close();
});

test('stripManagerCookies removes only the manager cookies', () => {
  const app = loadServer({});
  const { stripManagerCookies } = app.mod;
  assert.equal(stripManagerCookies('kasm_session=abc'), null);
  assert.equal(stripManagerCookies('a=1; kasm_session=abc; b=2'), 'a=1; b=2');
  assert.equal(stripManagerCookies('kasm_oauth_state=x; keep=1'), 'keep=1');
  assert.equal(stripManagerCookies('not_kasm_session=abc'), 'not_kasm_session=abc');
  assert.equal(stripManagerCookies(undefined), undefined);
  return app.close();
});

test('sanitizeRewrittenHeaders drops framing and hop-by-hop headers', () => {
  const app = loadServer({});
  const cleaned = app.mod.sanitizeRewrittenHeaders({
    'transfer-encoding': 'chunked', 'content-length': '10', 'content-encoding': 'gzip',
    'content-type': 'text/html', connection: 'keep-alive', 'x-frame-options': 'DENY',
  });
  assert.deepEqual(Object.keys(cleaned), ['x-frame-options']);
  return app.close();
});
