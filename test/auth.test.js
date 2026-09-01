'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadServer, raw, cookieFrom, login } = require('./helpers');

const GITHUB = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'secret', SESSION_SECRET: 'test-secret' };

test('unauthenticated API requests are rejected', async (t) => {
  const app = loadServer({ ...GITHUB, GITHUB_ALLOWED_USERS: 'octocat' });
  t.after(() => app.close());
  await app.ready;

  const res = await raw(app.port(), '/api/instances');
  assert.equal(res.status, 401);
});

test('/api/config reveals nothing but the login affordance before sign-in', async (t) => {
  const app = loadServer({ ...GITHUB, GITHUB_ALLOWED_USERS: 'octocat' });
  t.after(() => app.close());
  await app.ready;

  const body = (await raw(app.port(), '/api/config')).json();
  assert.deepEqual(Object.keys(body).sort(), ['authEnabled', 'authProvider', 'loginUrl']);
  assert.equal(body.authProvider, 'github');
});

test('the authorize redirect carries state, scopes and the callback', async (t) => {
  const app = loadServer({ ...GITHUB, GITHUB_ALLOWED_USERS: 'octocat' });
  t.after(() => app.close());
  await app.ready;

  const res = await raw(app.port(), '/auth/github/login');
  const state = cookieFrom(res.headers['set-cookie'], 'kasm_oauth_state');
  assert.equal(res.status, 302);
  assert.ok(res.headers.location.startsWith('https://github.com/login/oauth/authorize?'));
  assert.ok(res.headers.location.includes('client_id=cid'));
  assert.ok(res.headers.location.includes('scope=read%3Auser+user%3Aemail'));
  assert.ok(res.headers.location.includes(`state=${state}`));
});

test('the callback refuses a missing or mismatched state', async (t) => {
  const app = loadServer({ ...GITHUB, GITHUB_ALLOWED_USERS: 'octocat' });
  t.after(() => app.close());
  await app.ready;

  const start = await raw(app.port(), '/auth/github/login');
  const state = cookieFrom(start.headers['set-cookie'], 'kasm_oauth_state');

  const noCookie = await raw(app.port(), `/auth/github/callback?code=a&state=${state}`);
  assert.ok(noCookie.headers.location.includes('auth_error'));
  assert.equal(cookieFrom(noCookie.headers['set-cookie'], 'kasm_session'), null);

  const wrong = await raw(app.port(), `/auth/github/callback?code=a&state=${'0'.repeat(state.length)}`, {
    headers: { Cookie: `kasm_oauth_state=${state}` },
  });
  assert.ok(wrong.headers.location.includes('auth_error'));
  assert.equal(cookieFrom(wrong.headers['set-cookie'], 'kasm_session'), null);
});

test('an allow-listed login signs in and reaches the API', async (t) => {
  const app = loadServer({ ...GITHUB, GITHUB_ALLOWED_USERS: 'Octocat' });
  t.after(() => app.close());
  await app.ready;

  const { session, callback } = await login(app.port());
  assert.ok(session, 'expected a session cookie');
  assert.equal(callback.headers.location, '/');
  assert.ok([].concat(callback.headers['set-cookie']).some((c) => c.startsWith('kasm_session=') && /HttpOnly/.test(c)));

  const me = (await raw(app.port(), '/api/me', { headers: { Cookie: `kasm_session=${session}` } })).json();
  assert.equal(me.user.login, 'octocat');
});

test('a GitHub account outside the allow list is refused', async (t) => {
  const app = loadServer({ ...GITHUB, GITHUB_ALLOWED_USERS: 'somebody-else' });
  t.after(() => app.close());
  await app.ready;

  const { session, callback } = await login(app.port());
  assert.equal(session, null);
  assert.ok(callback.headers.location.includes('auth_error'));
});

test('only verified emails satisfy the email allow list', async (t) => {
  const allowed = loadServer({ ...GITHUB, GITHUB_ALLOWED_EMAILS: 'listed@example.com' }, {
    emails: [{ email: 'LISTED@example.com', verified: true }],
  });
  await allowed.ready;
  assert.ok((await login(allowed.port())).session, 'verified email should be accepted');
  await allowed.close();

  const refused = loadServer({ ...GITHUB, GITHUB_ALLOWED_EMAILS: 'listed@example.com' }, {
    emails: [{ email: 'listed@example.com', verified: false }],
  });
  await refused.ready;
  assert.equal((await login(refused.port())).session, null, 'unverified email must not be accepted');
  await refused.close();
});

test('an email placed in GITHUB_ALLOWED_USERS is matched as an email', async (t) => {
  const app = loadServer({ ...GITHUB, GITHUB_ALLOWED_USERS: 'someone,by-email@example.com' }, {
    profile: { login: 'stranger' },
    emails: [{ email: 'by-email@example.com', verified: true }],
  });
  t.after(() => app.close());
  await app.ready;
  assert.ok((await login(app.port())).session);
});

test('org membership admits a user who is on no list', async (t) => {
  const app = loadServer({ ...GITHUB, GITHUB_ALLOWED_ORG: 'acme' }, { profile: { login: 'newhire' } });
  t.after(() => app.close());
  await app.ready;
  assert.ok((await login(app.port())).session);
});

test('a pending org invitation is not membership', async (t) => {
  const app = loadServer({ ...GITHUB, GITHUB_ALLOWED_ORG: 'acme' });
  app.state.orgMembership = { state: 'pending' };
  t.after(() => app.close());
  await app.ready;
  assert.equal((await login(app.port())).session, null);
});

test('team membership is required when a team is configured', async (t) => {
  const app = loadServer({ ...GITHUB, GITHUB_ALLOWED_ORG: 'acme', GITHUB_ALLOWED_TEAM: 'desktops' });
  t.after(() => app.close());
  await app.ready;

  app.state.teams = [{ slug: 'other', organization: { login: 'acme' } }];
  assert.equal((await login(app.port())).session, null, 'wrong team must be refused');

  app.state.teams = [{ slug: 'desktops', organization: { login: 'acme' } }];
  assert.ok((await login(app.port())).session, 'correct team must be admitted');
});

test('logout revokes the session', async (t) => {
  const app = loadServer({ ...GITHUB, GITHUB_ALLOWED_USERS: 'octocat' });
  t.after(() => app.close());
  await app.ready;

  const { session } = await login(app.port());
  const cookie = `kasm_session=${session}`;
  assert.equal((await raw(app.port(), '/api/instances', { headers: { Cookie: cookie } })).status, 200);

  await raw(app.port(), '/api/logout', { method: 'POST', headers: { Cookie: cookie } });
  assert.equal((await raw(app.port(), '/api/instances', { headers: { Cookie: cookie } })).status, 401);
});

test('a tampered session cookie is rejected', async (t) => {
  const app = loadServer({ ...GITHUB, GITHUB_ALLOWED_USERS: 'octocat' });
  t.after(() => app.close());
  await app.ready;

  const { session } = await login(app.port());
  const [payload, signature] = session.split('.');
  const forged = Buffer.from(JSON.stringify({
    login: 'intruder', isAdmin: true, exp: Date.now() + 60000, jti: 'x',
  })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  for (const bad of [`${forged}.${signature}`, `${payload}.${'a'.repeat(signature.length)}`, payload]) {
    const res = await raw(app.port(), '/api/instances', { headers: { Cookie: `kasm_session=${bad}` } });
    assert.equal(res.status, 401, `forged cookie accepted: ${bad.slice(0, 24)}`);
  }
});

test('sessions survive a restart when SESSION_SECRET is fixed', async (t) => {
  const first = loadServer({ ...GITHUB, GITHUB_ALLOWED_USERS: 'octocat' });
  await first.ready;
  const { session } = await login(first.port());
  await first.close();

  const second = loadServer({ ...GITHUB, GITHUB_ALLOWED_USERS: 'octocat' });
  t.after(() => second.close());
  await second.ready;

  const res = await raw(second.port(), '/api/instances', { headers: { Cookie: `kasm_session=${session}` } });
  assert.equal(res.status, 200, 'a signed session should still be valid after a restart');
});

test('reverse-proxy auth ignores an unauthenticated header', async (t) => {
  const app = loadServer({ ...GITHUB, GITHUB_ALLOWED_USERS: 'octocat', ENABLE_REVERSE_PROXY_AUTH: 'true' });
  t.after(() => app.close());
  await app.ready;

  const res = await raw(app.port(), '/api/instances', { headers: { 'x-forwarded-user': 'anyone' } });
  assert.equal(res.status, 401, 'a bare header must not authorize anybody');
});

test('reverse-proxy auth requires the shared secret when one is set', async (t) => {
  const app = loadServer({
    ...GITHUB,
    GITHUB_ALLOWED_USERS: 'octocat',
    ENABLE_REVERSE_PROXY_AUTH: 'true',
    REVERSE_PROXY_REQUIRED_VALUE: 'trusted@example.com',
    REVERSE_PROXY_SHARED_SECRET: 'gateway-secret',
  });
  t.after(() => app.close());
  await app.ready;

  const noSecret = await raw(app.port(), '/api/instances', { headers: { 'x-forwarded-user': 'trusted@example.com' } });
  assert.equal(noSecret.status, 401);

  const wrongUser = await raw(app.port(), '/api/instances', {
    headers: { 'x-forwarded-user': 'someone-else', 'x-kasm-proxy-secret': 'gateway-secret' },
  });
  assert.equal(wrongUser.status, 401);

  const ok = await raw(app.port(), '/api/instances', {
    headers: { 'x-forwarded-user': 'trusted@example.com', 'x-kasm-proxy-secret': 'gateway-secret' },
  });
  assert.equal(ok.status, 200);
});

test('mutating requests from another origin are rejected', async (t) => {
  const app = loadServer({ ...GITHUB, GITHUB_ALLOWED_USERS: 'octocat' });
  t.after(() => app.close());
  await app.ready;

  const { session } = await login(app.port());
  const res = await raw(app.port(), '/api/instances/anything', {
    method: 'DELETE',
    headers: { Cookie: `kasm_session=${session}`, Origin: 'https://evil.example.com' },
  });
  assert.equal(res.status, 403);
});
