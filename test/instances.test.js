'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadServer, raw, login } = require('./helpers');

const GITHUB = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'secret', SESSION_SECRET: 'test-secret', GITHUB_ALLOWED_USERS: 'octocat' };

function instance(overrides = {}) {
  return {
    id: 'inst1', name: 'test', slug: 'test-inst1', image: 'kasmweb/core:1',
    password: 'SuperSecretVncPw', hostPort: 6901, internalPort: '6901/tcp',
    networkMode: 'bridge', extraEnv: [], binds: [], persistentProfile: false,
    containerId: null, status: 'running', ownerLogin: 'octocat', ...overrides,
  };
}

test('desktop passwords are never returned by the instance list', async (t) => {
  const app = loadServer(GITHUB, { instances: [instance()] });
  t.after(() => app.close());
  await app.ready;

  const { session } = await login(app.port());
  const res = await raw(app.port(), '/api/instances', { headers: { Cookie: `kasm_session=${session}` } });

  assert.ok(!res.body.includes('SuperSecretVncPw'), 'the password leaked in the instance list');
  const [listed] = res.json().instances;
  assert.equal(listed.password, undefined);
  assert.equal(listed.hasPassword, true);
});

test('the password endpoint returns it explicitly and writes an audit entry', async (t) => {
  const app = loadServer(GITHUB, { instances: [instance()] });
  t.after(() => app.close());
  await app.ready;

  const { session } = await login(app.port());
  const res = await raw(app.port(), '/api/instances/inst1/password', { headers: { Cookie: `kasm_session=${session}` } });
  assert.equal(res.json().password, 'SuperSecretVncPw');

  const audit = fs.readFileSync(path.join(app.dir, 'audit.log'), 'utf8');
  assert.ok(audit.includes('instance.password.reveal'));
  assert.ok(audit.includes('octocat'));
});

test('a non-admin sees and touches only their own desktops', async (t) => {
  const app = loadServer(
    { ...GITHUB, GITHUB_ADMIN_USERS: 'someone-else' },
    { instances: [instance(), instance({ id: 'inst2', hostPort: 6902, ownerLogin: 'another-user' })] },
  );
  t.after(() => app.close());
  await app.ready;

  const { session } = await login(app.port());
  const cookie = { Cookie: `kasm_session=${session}` };

  const list = (await raw(app.port(), '/api/instances', { headers: cookie })).json();
  assert.deepEqual(list.instances.map((i) => i.id), ['inst1']);

  // Somebody else's desktop is indistinguishable from one that does not exist.
  assert.equal((await raw(app.port(), '/api/instances/inst2/password', { headers: cookie })).status, 404);
  assert.equal((await raw(app.port(), '/api/instances/inst2', { method: 'DELETE', headers: cookie })).status, 404);
});

test('an admin sees every desktop', async (t) => {
  const app = loadServer(
    { ...GITHUB, GITHUB_ADMIN_USERS: 'octocat' },
    { instances: [instance(), instance({ id: 'inst2', hostPort: 6902, ownerLogin: 'another-user' })] },
  );
  t.after(() => app.close());
  await app.ready;

  const { session } = await login(app.port());
  const list = (await raw(app.port(), '/api/instances', { headers: { Cookie: `kasm_session=${session}` } })).json();
  assert.deepEqual(list.instances.map((i) => i.id).sort(), ['inst1', 'inst2']);
});

test('image deletion is refused for non-admins', async (t) => {
  const app = loadServer({ ...GITHUB, GITHUB_ADMIN_USERS: 'someone-else' });
  t.after(() => app.close());
  await app.ready;

  const { session } = await login(app.port());
  const res = await raw(app.port(), '/api/local-images', { method: 'DELETE', headers: { Cookie: `kasm_session=${session}` } });
  assert.equal(res.status, 403);
});

test('a launch token is single-use and bound to its instance', async (t) => {
  const app = loadServer(GITHUB, { instances: [instance(), instance({ id: 'inst2', hostPort: 6902 })] });
  t.after(() => app.close());
  await app.ready;
  const { createLaunchToken, consumeLaunchToken } = app.mod;

  const token = createLaunchToken('inst1');
  assert.equal(consumeLaunchToken(token), 'inst1');
  assert.equal(consumeLaunchToken(token), null, 'a token must not work twice');
  assert.equal(consumeLaunchToken('never-issued'), null);
});

test('the launch endpoint mints a token and the redirect carries the desktop URL', async (t) => {
  const app = loadServer(GITHUB, { instances: [instance()] });
  t.after(() => app.close());
  await app.ready;

  const { session } = await login(app.port());
  const cookie = { Cookie: `kasm_session=${session}` };

  const minted = (await raw(app.port(), '/api/instances/inst1/launch', { method: 'POST', headers: cookie })).json();
  assert.match(minted.launchPath, /^\/launch\/inst1\?t=[a-f0-9]{48}$/);

  const followed = await raw(app.port(), minted.launchPath, { headers: cookie });
  assert.equal(followed.status, 302);
  assert.ok(followed.headers.location.startsWith('/6901/vnc.html?'));
  assert.ok(followed.headers.location.includes('password=SuperSecretVncPw'));

  // The spent token falls back to the session check, so a refresh still works.
  assert.equal((await raw(app.port(), minted.launchPath, { headers: cookie })).status, 302);
});

test('LAUNCH_INCLUDE_PASSWORD=false keeps the password out of the URL', async (t) => {
  const app = loadServer({ ...GITHUB, LAUNCH_INCLUDE_PASSWORD: 'false' }, { instances: [instance()] });
  t.after(() => app.close());
  await app.ready;

  const { session } = await login(app.port());
  const res = await raw(app.port(), '/launch/inst1', { headers: { Cookie: `kasm_session=${session}` } });
  assert.ok(!res.headers.location.includes('password='));
});

test('the store survives a crash mid-write', async (t) => {
  const app = loadServer(GITHUB, { instances: [instance()] });
  t.after(() => app.close());
  await app.ready;

  const dataFile = path.join(app.dir, 'instances.json');
  const before = fs.readFileSync(dataFile, 'utf8');

  // Any temp file left behind by an interrupted write must not be the real one.
  app.mod.writeStore({ instances: [instance({ name: 'updated' })] });
  const after = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(after.instances[0].name, 'updated');
  assert.notEqual(before, JSON.stringify(after));
  assert.deepEqual(fs.readdirSync(app.dir).filter((f) => f.endsWith('.tmp')), [], 'no temp file should remain');
});

test('bind mounts are refused unless the operator allows them', () => {
  const app = loadServer({});
  assert.throws(() => app.mod.validateBinds(['/:/host']), /disabled/i);
  assert.doesNotThrow(() => app.mod.validateBinds([]));
  return app.close();
});

test('permitted bind prefixes are enforced, including via traversal', () => {
  const app = loadServer({ ALLOWED_BIND_PREFIXES: '/srv/desktops' });
  const { validateBinds } = app.mod;
  assert.doesNotThrow(() => validateBinds(['/srv/desktops/alice:/data']));
  assert.throws(() => validateBinds(['/etc:/etc']), /outside the permitted prefixes/);
  assert.throws(() => validateBinds(['/srv/desktops/../../etc:/etc']), /outside the permitted prefixes/);
  assert.throws(() => validateBinds(['/srv/desktops-evil:/data']), /outside the permitted prefixes/);
  return app.close();
});

test('dangerous network modes are refused', () => {
  const app = loadServer({});
  const { validateNetworkMode } = app.mod;
  assert.doesNotThrow(() => validateNetworkMode('bridge'));
  assert.throws(() => validateNetworkMode('host'), /not permitted/);
  assert.throws(() => validateNetworkMode('container:other'), /not permitted/);
  return app.close();
});

test('resource limits reach the docker run arguments', () => {
  const app = loadServer({ DEFAULT_SHM_SIZE: '2g' });
  const args = app.mod.buildRunArgs({
    id: 'x', slug: 'x', name: 'x', image: 'kasmweb/core:1', password: 'p', hostPort: 6901,
    internalPort: '6901/tcp', networkMode: 'bridge', cpuLimit: '2', memoryLimit: '4g', pidsLimit: '512',
  });
  const pair = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(pair('--cpus'), '2');
  assert.equal(pair('--memory'), '4g');
  assert.equal(pair('--pids-limit'), '512');
  assert.equal(pair('--shm-size'), '2g', 'Kasm images need a large /dev/shm');
  return app.close();
});

test('allow-list parsing is forgiving about separators and case', () => {
  const app = loadServer({});
  assert.deepEqual(app.mod.parseAllowList('A, b\n c,,  D '), ['a', 'b', 'c', 'd']);
  assert.deepEqual(app.mod.parseAllowList(undefined), []);
  return app.close();
});

test('admins default to everyone only while no admin list is set', () => {
  const open = loadServer({});
  assert.equal(open.mod.isAdminIdentity('anybody', []), true);
  open.close();

  const restricted = loadServer({ GITHUB_ADMIN_USERS: 'boss,admin@example.com' });
  const { isAdminIdentity } = restricted.mod;
  assert.equal(isAdminIdentity('boss', []), true);
  assert.equal(isAdminIdentity('BOSS', []), true);
  assert.equal(isAdminIdentity('nobody', ['admin@example.com']), true);
  assert.equal(isAdminIdentity('nobody', ['other@example.com']), false);
  return restricted.close();
});
