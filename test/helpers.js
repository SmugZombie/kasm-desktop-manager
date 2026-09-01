'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

// Loads server.js in a child-free way: fresh env, fresh module registry, and a
// stubbed global fetch so no test ever reaches github.com.
function loadServer(env = {}, { profile = {}, emails = [], instances = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasm-test-'));
  fs.writeFileSync(path.join(dir, 'instances.json'), JSON.stringify({ instances }));

  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (/^(GITHUB_|SESSION_|REVERSE_PROXY_|LAUNCH_|PROXY_|ALLOW|DEFAULT_|DOCKER_|IDLE_|DESKTOP_|FORCE_|PORT|DATA_FILE|AUDIT_)/.test(key)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, {
    PORT: '0',
    DATA_FILE: path.join(dir, 'instances.json'),
    IMAGE_PRESETS_FILE: path.join(dir, 'presets.json'),
    AUDIT_LOG_FILE: path.join(dir, 'audit.log'),
    ...env,
  });

  const state = {
    profile: { login: 'octocat', name: 'The Octocat', email: 'pub@example.com', avatar_url: 'a', ...profile },
    emails,
    orgMembership: { state: 'active' },
    teams: [],
  };

  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    const u = String(url);
    if (u.includes('login/oauth/access_token')) return ok({ access_token: 'tok' });
    if (u.endsWith('/user')) return ok(state.profile);
    if (u.endsWith('/user/emails')) return ok(state.emails);
    if (u.includes('/user/memberships/orgs/')) return ok(state.orgMembership);
    if (u.includes('/user/teams')) return ok(state.teams);
    throw new Error(`unexpected fetch: ${u}`);
  };

  delete require.cache[require.resolve('../server.js')];
  const mod = require('../server.js');

  const server = mod.server;
  const listening = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    mod,
    state,
    dir,
    ready: listening,
    port: () => server.address().port,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      global.fetch = realFetch;
      process.env = saved;
      delete require.cache[require.resolve('../server.js')];
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Raw HTTP so we can inspect malformed responses that Node's client would reject.
function raw(port, pathname, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const host = Object.entries(headers).find(([k]) => k.toLowerCase() === 'host')?.[1];
      const lines = [`${method} ${pathname} HTTP/1.1`, `Host: ${host || `127.0.0.1:${port}`}`, 'Connection: close'];
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === 'host') continue;
        lines.push(`${k}: ${v}`);
      }
      if (body) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`);
    });
    let text = '';
    socket.on('data', (chunk) => { text += chunk; });
    socket.on('error', reject);
    socket.on('end', () => {
      const splitAt = text.indexOf('\r\n\r\n');
      const head = text.slice(0, splitAt);
      const [statusLine, ...headerLines] = head.split('\r\n');
      const headers = {};
      const setCookie = [];
      for (const line of headerLines) {
        const i = line.indexOf(':');
        const key = line.slice(0, i).toLowerCase().trim();
        const value = line.slice(i + 1).trim();
        if (key === 'set-cookie') setCookie.push(value);
        else headers[key] = value;
      }
      if (setCookie.length) headers['set-cookie'] = setCookie;
      resolve({
        raw: text,
        head,
        status: Number(statusLine.split(' ')[1]),
        headers,
        body: text.slice(splitAt + 4),
        json() { try { return JSON.parse(this.body); } catch { return null; } },
      });
    });
  });
}

function cookieFrom(setCookie, name) {
  for (const cookie of [].concat(setCookie || [])) {
    const match = cookie.match(new RegExp(`^${name}=([^;]*)`));
    if (match && match[1]) return match[1];
  }
  return null;
}

// Drives the full OAuth round trip and returns the resulting session cookie.
async function login(port) {
  const start = await raw(port, '/auth/github/login');
  const state = cookieFrom(start.headers['set-cookie'], 'kasm_oauth_state');
  const callback = await raw(port, `/auth/github/callback?code=abc&state=${state}`, {
    headers: { Cookie: `kasm_oauth_state=${state}` },
  });
  return { state, callback, session: cookieFrom(callback.headers['set-cookie'], 'kasm_session') };
}

// A stand-in Kasm desktop that records what the proxy forwarded to it.
function fakeDesktop(port) {
  const received = {};
  const server = http.createServer((req, res) => {
    received.headers = req.headers;
    received.url = req.url;
    res.writeHead(200, { 'Content-Type': 'text/html' }); // chunked: no content-length
    res.end('<html><body><a href="/app.js">x</a></body></html>');
  });
  return {
    received,
    ready: new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { loadServer, raw, cookieFrom, login, fakeDesktop };
