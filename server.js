
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const rootDir = __dirname;
loadDotEnv(path.join(rootDir, '.env'));

const PORT = Number(process.env.PORT || 3000);

// ── Authentication ────────────────────────────────────────
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GITHUB_CALLBACK_URL = process.env.GITHUB_CALLBACK_URL || '';
const GITHUB_ALLOWED_USERS = parseAllowList(process.env.GITHUB_ALLOWED_USERS);
const GITHUB_ALLOWED_EMAILS = parseAllowList(process.env.GITHUB_ALLOWED_EMAILS);
const GITHUB_ALLOWED_ORG = String(process.env.GITHUB_ALLOWED_ORG || '').trim().toLowerCase();
const GITHUB_ALLOWED_TEAM = String(process.env.GITHUB_ALLOWED_TEAM || '').trim().toLowerCase();
const GITHUB_ADMIN_USERS = parseAllowList(process.env.GITHUB_ADMIN_USERS);
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_COOKIE_DOMAIN = String(process.env.SESSION_COOKIE_DOMAIN || '').trim();
const FORCE_SECURE_COOKIES = String(process.env.FORCE_SECURE_COOKIES || 'false').toLowerCase() === 'true';
const GITHUB_AUTH_ENABLED = Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);
const ENABLE_REVERSE_PROXY_AUTH = String(process.env.ENABLE_REVERSE_PROXY_AUTH || 'false').toLowerCase() === 'true';
const REVERSE_PROXY_USER_HEADER = (process.env.REVERSE_PROXY_USER_HEADER || 'x-forwarded-user').toLowerCase();
const REVERSE_PROXY_REQUIRED_VALUE = process.env.REVERSE_PROXY_REQUIRED_VALUE || '';
const REVERSE_PROXY_SHARED_SECRET = process.env.REVERSE_PROXY_SHARED_SECRET || '';
const REVERSE_PROXY_SECRET_HEADER = (process.env.REVERSE_PROXY_SECRET_HEADER || 'x-kasm-proxy-secret').toLowerCase();

// ── Desktop container policy ──────────────────────────────
const PASSWORD_ENV_KEY = process.env.PASSWORD_ENV_KEY || 'VNC_PW';
const ALLOW_CUSTOM_BINDS = String(process.env.ALLOW_CUSTOM_BINDS || 'false').toLowerCase() === 'true';
const ALLOWED_BIND_PREFIXES = String(process.env.ALLOWED_BIND_PREFIXES || '')
  .split(',').map((item) => item.trim()).filter(Boolean);
const ALLOWED_NETWORK_MODES = String(process.env.ALLOWED_NETWORK_MODES || 'bridge,none')
  .split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
const DEFAULT_CPU_LIMIT = String(process.env.DEFAULT_CPU_LIMIT || '').trim();
const DEFAULT_MEMORY_LIMIT = String(process.env.DEFAULT_MEMORY_LIMIT || '').trim();
const DEFAULT_SHM_SIZE = String(process.env.DEFAULT_SHM_SIZE || '2g').trim();
const DEFAULT_PIDS_LIMIT = String(process.env.DEFAULT_PIDS_LIMIT || '').trim();
const DOCKER_TIMEOUT_MS = Number(process.env.DOCKER_TIMEOUT_MS || 60_000);
const DOCKER_PULL_TIMEOUT_MS = Number(process.env.DOCKER_PULL_TIMEOUT_MS || 20 * 60_000);
const IDLE_TIMEOUT_MINUTES = Number(process.env.IDLE_TIMEOUT_MINUTES || 0);
const LAUNCH_TOKEN_TTL_SECONDS = Number(process.env.LAUNCH_TOKEN_TTL_SECONDS || 120);
const LAUNCH_INCLUDE_PASSWORD = String(process.env.LAUNCH_INCLUDE_PASSWORD || 'true').toLowerCase() === 'true';
const AUDIT_LOG_FILE = process.env.AUDIT_LOG_FILE || '';
const DEFAULT_INTERNAL_PORT = process.env.DEFAULT_INTERNAL_PORT || '6901/tcp';
const DEFAULT_NETWORK_MODE = process.env.DEFAULT_NETWORK_MODE || 'bridge';
const DEFAULT_PROFILE_MOUNT_PATH = process.env.DEFAULT_PROFILE_MOUNT_PATH || '/home/kasm-user';
const INSTANCE_NAME_PREFIX = process.env.INSTANCE_NAME_PREFIX || 'kasm-desktop-';
const PROFILE_VOLUME_PREFIX = process.env.PROFILE_VOLUME_PREFIX || 'kasm-profile-';
const MANAGED_LABEL = process.env.MANAGED_LABEL || 'com.egli.kasm-manager.managed';
const DATA_FILE = process.env.DATA_FILE || path.join(rootDir, 'data', 'instances.json');
const IMAGE_PRESETS_FILE = process.env.IMAGE_PRESETS_FILE || path.join(rootDir, 'data', 'image-presets.json');
const PUBLIC_DIR = path.join(rootDir, 'public');
const AUDIT_FILE = AUDIT_LOG_FILE || path.join(path.dirname(DATA_FILE), 'audit.log');
const PROXY_TARGET_HOST = process.env.PROXY_TARGET_HOST || 'host.docker.internal';
const DESKTOP_HOSTNAME_TEMPLATE = String(process.env.DESKTOP_HOSTNAME_TEMPLATE || '').trim().toLowerCase();
const HOSTNAME_MODE = DESKTOP_HOSTNAME_TEMPLATE.includes('{port}');
const PROXY_UPSTREAM_HTTPS = String(process.env.PROXY_UPSTREAM_HTTPS || 'true').toLowerCase() === 'true';
const PROXY_UPSTREAM_USER = process.env.PROXY_UPSTREAM_USER || 'kasm_user';
const PROXY_TEXT_REWRITE = String(process.env.PROXY_TEXT_REWRITE || 'true').toLowerCase() === 'true';
const LAUNCH_AUTOCONNECT = String(process.env.LAUNCH_AUTOCONNECT || 'true').toLowerCase() === 'true';
const PORT_RANGE_START = Number(process.env.PORT_RANGE_START || 6901);
const PORT_RANGE_END   = Number(process.env.PORT_RANGE_END   || 6999);
const MAX_INSTANCES    = Number(process.env.MAX_INSTANCES    || 10);
const LAUNCH_RESIZE = process.env.LAUNCH_RESIZE || 'remote';
const LAUNCH_VIEW_ONLY = String(process.env.LAUNCH_VIEW_ONLY || 'false').toLowerCase() === 'true';

ensureStore();

if (!GITHUB_AUTH_ENABLED && !ENABLE_REVERSE_PROXY_AUTH) {
  console.warn('[auth] WARNING: GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET are not set — the manager is running with authentication DISABLED.');
} else if (GITHUB_AUTH_ENABLED && !GITHUB_ALLOWED_USERS.length && !GITHUB_ALLOWED_EMAILS.length && !GITHUB_ALLOWED_ORG) {
  console.warn('[auth] WARNING: GitHub auth is enabled but GITHUB_ALLOWED_USERS/GITHUB_ALLOWED_EMAILS/GITHUB_ALLOWED_ORG are empty — nobody will be able to sign in.');
}

if (GITHUB_AUTH_ENABLED && !SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET is not set — a random one was generated, so every restart signs users out.');
}

if (ENABLE_REVERSE_PROXY_AUTH && !REVERSE_PROXY_REQUIRED_VALUE && !REVERSE_PROXY_SHARED_SECRET) {
  console.warn('[auth] WARNING: ENABLE_REVERSE_PROXY_AUTH is on but neither REVERSE_PROXY_REQUIRED_VALUE nor REVERSE_PROXY_SHARED_SECRET is set — reverse-proxy auth is disabled to prevent header spoofing.');
}

function parseAllowList(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function ensureStore() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ instances: [] }, null, 2));
}

// The store is held in memory and written through to disk. Every proxied request
// resolves an instance, so re-reading and re-parsing the file each time was the
// hottest synchronous work in the process.
let storeCache = null;

function readStore() {
  if (storeCache) return storeCache;
  ensureStore();
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    storeCache = Array.isArray(raw.instances) ? raw : { instances: [] };
  } catch {
    storeCache = { instances: [] };
  }
  return storeCache;
}

// Write to a sibling temp file and rename, so a crash or a full disk can never
// leave a truncated instances.json behind.
function writeStore(payload) {
  storeCache = payload;
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// Serialises read-modify-write sequences (port allocation, concurrent creates)
// so two requests cannot both claim the same host port.
let storeLock = Promise.resolve();

function withStoreLock(fn) {
  const result = storeLock.then(fn, fn);
  storeLock = result.then(() => undefined, () => undefined);
  return result;
}

function getInstances() {
  return readStore().instances || [];
}

function getInstance(id) {
  return getInstances().find((item) => item.id === id) || null;
}

function saveInstance(instance) {
  const store = readStore();
  const instances = [...store.instances];
  const idx = instances.findIndex((item) => item.id === instance.id);
  if (idx >= 0) instances[idx] = instance;
  else instances.push(instance);
  writeStore({ ...store, instances });
  return instance;
}

function updateInstance(id, updater) {
  const store = readStore();
  const idx = store.instances.findIndex((item) => item.id === id);
  if (idx === -1) return null;
  const instances = [...store.instances];
  instances[idx] = updater(instances[idx]);
  writeStore({ ...store, instances });
  return instances[idx];
}

function removeInstance(id) {
  const store = readStore();
  writeStore({ ...store, instances: store.instances.filter((item) => item.id !== id) });
}

// ── Audit log ─────────────────────────────────────────────
function audit(actor, action, detail = {}) {
  const entry = {
    at: new Date().toISOString(),
    actor: actor || 'anonymous',
    action,
    ...detail,
  };
  try {
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    console.error(`[audit] could not write audit entry: ${error.message}`);
  }
  return entry;
}

function readAudit(limit = 200) {
  try {
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean).reverse();
  } catch {
    return [];
  }
}

function sanitizeExtraEnv(extraEnv) {
  if (!Array.isArray(extraEnv)) return [];
  return extraEnv
    .filter((item) => item && typeof item.key === 'string' && item.key.trim())
    .map((item) => ({ key: item.key.trim(), value: item.value == null ? '' : String(item.value) }));
}

function sanitizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((item) => item.trim()).filter(Boolean);
}

function loadPresets() {
  if (!fs.existsSync(IMAGE_PRESETS_FILE)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(IMAGE_PRESETS_FILE, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((item) => item && item.name && item.image).map((item) => ({
      name: String(item.name),
      image: String(item.image),
      internalPort: item.internalPort ? String(item.internalPort) : DEFAULT_INTERNAL_PORT,
      networkMode: item.networkMode ? String(item.networkMode) : DEFAULT_NETWORK_MODE,
      profileMountPath: item.profileMountPath ? String(item.profileMountPath) : DEFAULT_PROFILE_MOUNT_PATH,
      extraEnv: sanitizeExtraEnv(item.extraEnv),
      binds: sanitizeStringArray(item.binds),
    }));
  } catch {
    return [];
  }
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function buildContainerName(instance) {
  return `${INSTANCE_NAME_PREFIX}${instance.slug}`;
}

function buildVolumeName(instance) {
  return instance.profileVolumeName || `${PROFILE_VOLUME_PREFIX}${instance.slug}`;
}

async function docker(args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: DOCKER_TIMEOUT_MS,
      ...options,
    });
    return { stdout, stderr };
  } catch (error) {
    if (error.killed || error.code === 'ETIMEDOUT') {
      throw new Error(`Docker command timed out after ${options.timeout ?? DOCKER_TIMEOUT_MS}ms: docker ${args[0]}`);
    }
    const detail = error.stderr || error.stdout || error.message;
    throw new Error(String(detail).trim() || 'Docker command failed');
  }
}

async function dockerJson(args) {
  const { stdout } = await docker(args);
  const text = stdout.trim();
  return text ? JSON.parse(text) : null;
}

async function pingDocker() {
  await docker(['version', '--format', '{{json .}}']);
}

async function listLocalKasmImages() {
  const { stdout } = await docker(['images', '--format', '{{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedAt}}', '--filter', 'reference=kasmweb/*']);
  return stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [ref, size, ...rest] = line.split('\t');
    const [repository, tag] = ref.split(':');
    return { repository, tag, size, createdAt: rest.join('\t') };
  });
}

async function imagePull(image) {
  await docker(['pull', image], { timeout: DOCKER_PULL_TIMEOUT_MS });
}

async function containerLogs(containerId, tail = 200) {
  const { stdout, stderr } = await docker(['logs', '--tail', String(tail), '--timestamps', containerId]);
  return `${stderr || ''}${stdout || ''}`;
}

async function containerStats(containerId) {
  const { stdout } = await docker([
    'stats', '--no-stream', '--format',
    '{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}',
    containerId,
  ]);
  const [cpu, mem, memPerc, netIO, blockIO, pids] = stdout.trim().split('\t');
  return { cpu, mem, memPerc, netIO, blockIO, pids };
}

// A bind mount is a straight path to host root, so custom binds are refused
// unless the operator has opted in and, optionally, pinned them to a prefix.
function validateBinds(binds) {
  if (!binds.length) return binds;
  if (!ALLOW_CUSTOM_BINDS && !ALLOWED_BIND_PREFIXES.length) {
    throw new Error('Custom bind mounts are disabled. Set ALLOW_CUSTOM_BINDS=true or ALLOWED_BIND_PREFIXES to permit them.');
  }
  if (ALLOWED_BIND_PREFIXES.length) {
    for (const bind of binds) {
      const source = String(bind).split(':')[0];
      if (!source.startsWith('/')) continue; // named volume, not a host path
      const resolved = path.resolve(source);
      const permitted = ALLOWED_BIND_PREFIXES.some((prefix) => {
        const base = path.resolve(prefix);
        return resolved === base || resolved.startsWith(`${base}${path.sep}`);
      });
      if (!permitted) {
        throw new Error(`Bind mount "${source}" is outside the permitted prefixes (${ALLOWED_BIND_PREFIXES.join(', ')}).`);
      }
    }
  }
  return binds;
}

function validateNetworkMode(mode) {
  const normalized = String(mode || DEFAULT_NETWORK_MODE).toLowerCase();
  if (normalized.startsWith('container:')) {
    throw new Error('Network mode "container:" is not permitted.');
  }
  if (!ALLOWED_NETWORK_MODES.includes(normalized)) {
    throw new Error(`Network mode "${mode}" is not permitted (allowed: ${ALLOWED_NETWORK_MODES.join(', ')}).`);
  }
  return mode;
}

async function ensureProfileVolume(instance) {
  if (!instance.persistentProfile) return null;
  const volumeName = buildVolumeName(instance);
  try {
    await docker(['volume', 'inspect', volumeName]);
  } catch {
    await docker([
      'volume', 'create',
      '--label', `${MANAGED_LABEL}=true`,
      '--label', 'com.egli.kasm-manager.resource-type=profile-volume',
      '--label', `com.egli.kasm-manager.instance-id=${instance.id}`,
      '--label', `com.egli.kasm-manager.instance-name=${instance.name}`,
      volumeName,
    ]);
  }
  return volumeName;
}

function buildRunArgs(instance) {
  const internalPort = instance.internalPort || DEFAULT_INTERNAL_PORT;
  const args = ['run', '-d', '--restart', 'unless-stopped', '--name', buildContainerName(instance)];

  args.push('--label', `${MANAGED_LABEL}=true`);
  args.push('--label', 'com.egli.kasm-manager.resource-type=desktop-container');
  args.push('--label', `com.egli.kasm-manager.instance-id=${instance.id}`);
  args.push('--label', `com.egli.kasm-manager.instance-name=${instance.name}`);

  if (instance.networkMode) args.push('--network', instance.networkMode);
  args.push('-p', `${instance.hostPort}:${internalPort.replace('/tcp', '')}`);
  args.push('-e', `${PASSWORD_ENV_KEY}=${instance.password}`);

  // Kasm images need a large /dev/shm or the bundled browser crashes.
  const shmSize = instance.shmSize || DEFAULT_SHM_SIZE;
  if (shmSize) args.push('--shm-size', shmSize);
  const cpuLimit = instance.cpuLimit || DEFAULT_CPU_LIMIT;
  if (cpuLimit) args.push('--cpus', String(cpuLimit));
  const memoryLimit = instance.memoryLimit || DEFAULT_MEMORY_LIMIT;
  if (memoryLimit) args.push('--memory', String(memoryLimit));
  const pidsLimit = instance.pidsLimit || DEFAULT_PIDS_LIMIT;
  if (pidsLimit) args.push('--pids-limit', String(pidsLimit));

  for (const entry of instance.extraEnv || []) args.push('-e', `${entry.key}=${entry.value}`);
  for (const bind of instance.binds || []) args.push('-v', bind);
  if (instance.persistentProfile) args.push('-v', `${buildVolumeName(instance)}:${instance.profileMountPath || DEFAULT_PROFILE_MOUNT_PATH}`);

  args.push(instance.image);
  return args;
}

async function createAndStart(instance, { skipPull = false } = {}) {
  if (!skipPull) await imagePull(instance.image);
  await ensureProfileVolume(instance);
  await docker(buildRunArgs(instance));
  return inspectContainerByName(buildContainerName(instance));
}

async function inspectContainerByName(name) {
  return dockerJson(['inspect', name, '--format', '{{json .}}']);
}

async function inspectContainer(containerId) {
  return dockerJson(['inspect', containerId, '--format', '{{json .}}']);
}

async function startContainer(containerId) {
  await docker(['start', containerId]);
  return inspectContainer(containerId);
}

async function stopContainer(containerId) {
  await docker(['stop', '-t', '10', containerId]);
  return inspectContainer(containerId);
}

async function removeContainer(containerId, force = false) {
  const args = ['rm'];
  if (force) args.push('-f');
  args.push(containerId);
  await docker(args);
}

async function removeProfileVolume(instance) {
  if (!instance?.persistentProfile) return;
  await docker(['volume', 'rm', '-f', buildVolumeName(instance)]);
}

async function findContainerByInstanceId(instanceId) {
  const { stdout } = await docker([
    'ps', '-a',
    '--filter', `label=com.egli.kasm-manager.instance-id=${instanceId}`,
    '--format', '{{.ID}}'
  ]);
  const id = stdout.trim().split(/\r?\n/).filter(Boolean)[0];
  return id || null;
}

async function recreateInstance(instance, options = {}) {
  const existingId = await findContainerByInstanceId(instance.id);
  if (existingId) {
    try { await removeContainer(existingId, true); } catch {}
  } else if (instance.containerId) {
    try { await removeContainer(instance.containerId, true); } catch {}
  }
  if (options.clearProfile) {
    try { await removeProfileVolume(instance); } catch {}
  }
  return createAndStart(instance);
}

async function listUsedHostPorts() {
  const { stdout } = await docker(['ps', '-a', '--format', '{{.Ports}}']);
  const used = new Set();
  const portRegex = /(\d+)->/g;
  for (const line of stdout.split(/\r?\n/)) {
    let match;
    while ((match = portRegex.exec(line))) used.add(Number(match[1]));
  }
  return [...used].sort((a, b) => a - b);
}

async function findAvailablePort() {
  const assigned = new Set(getInstances().map((i) => Number(i.hostPort)));
  const inUse    = new Set(await listUsedHostPorts());
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!assigned.has(p) && !inUse.has(p)) return p;
  }
  throw new Error(`No available ports in range ${PORT_RANGE_START}–${PORT_RANGE_END}.`);
}

function buildLaunchUrl(instance, { protocol = 'https' } = {}) {
  // In hostname mode the desktop owns the root of its own hostname, so no path
  // prefix is involved and websockify sits at /websockify.
  const hostname = desktopHostnameFor(instance);
  const base = hostname ? `${protocol}://${hostname}` : '';
  const prefix = hostname ? '' : `/${instance.hostPort}`;

  const params = new URLSearchParams();
  if (LAUNCH_AUTOCONNECT) params.set('autoconnect', '1');
  if (LAUNCH_INCLUDE_PASSWORD && instance.password) params.set('password', instance.password);
  if (LAUNCH_RESIZE) params.set('resize', LAUNCH_RESIZE);
  params.set('path', hostname ? 'websockify' : `${instance.hostPort}/websockify`);
  params.set('reconnect', '1');
  if (LAUNCH_VIEW_ONLY) params.set('view_only', '1');
  return `${base}${prefix}/vnc.html?${params.toString()}`;
}

// The instance record holds the desktop password; API responses must not.
function presentInstance(instance, inspect = null) {
  const state = inspect?.State?.Status || instance.status || 'unknown';
  const { password, ...safe } = instance;
  return {
    ...safe,
    hasPassword: Boolean(password),
    state,
    containerId: inspect?.Id || instance.containerId || null,
    startedAt: inspect?.State?.StartedAt || null,
    finishedAt: inspect?.State?.FinishedAt || null,
    ports: inspect?.NetworkSettings?.Ports || null,
    launchPath: `/launch/${instance.id}`,
    desktopHostname: desktopHostnameFor(instance),
    pathPrefix: HOSTNAME_MODE ? null : `/${instance.hostPort}`,
    lastActiveAt: activity.get(instance.id) || null,
  };
}

// ── Launch tokens ─────────────────────────────────────────
// A launch URL carries the desktop password, so it is minted per click, tied to
// the instance, and usable once within a short window.
const launchTokens = new Map(); // token -> { instanceId, expiresAt }

function createLaunchToken(instanceId) {
  const token = crypto.randomBytes(24).toString('hex');
  launchTokens.set(token, { instanceId, expiresAt: Date.now() + LAUNCH_TOKEN_TTL_SECONDS * 1000 });
  return token;
}

function consumeLaunchToken(token) {
  const entry = launchTokens.get(token);
  if (!entry) return null;
  launchTokens.delete(token);
  if (Date.now() > entry.expiresAt) return null;
  return entry.instanceId;
}

function sweepLaunchTokens() {
  const now = Date.now();
  for (const [token, entry] of launchTokens) {
    if (now > entry.expiresAt) launchTokens.delete(token);
  }
}

// ── Idle tracking ─────────────────────────────────────────
const activity = new Map(); // instanceId -> timestamp

function markActive(instanceId) {
  if (instanceId) activity.set(instanceId, Date.now());
}

const SESSION_TTL_MS = Math.max(1, SESSION_TTL_HOURS) * 60 * 60 * 1000;

// Sessions are stateless signed cookies so a restart or a second replica does not
// sign everyone out. Logout and the revocation list still give us server-side
// invalidation for the tokens that matter.
const sessionSecret = SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const revokedSessions = new Map(); // jti -> expiry ms

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signSessionPayload(encodedPayload) {
  return base64url(crypto.createHmac('sha256', sessionSecret).update(encodedPayload).digest());
}

function createSession(user) {
  const now = Date.now();
  const payload = { ...user, jti: crypto.randomBytes(12).toString('hex'), iat: now, exp: now + SESSION_TTL_MS };
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${signSessionPayload(encoded)}`;
}

function getSession(token) {
  if (typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const encoded = token.slice(0, idx);
  const signature = token.slice(idx + 1);
  const expected = signSessionPayload(encoded);
  if (signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  if (payload.jti && revokedSessions.has(payload.jti)) return null;
  return { createdAt: payload.iat, user: payload };
}

function destroySession(token) {
  const session = getSession(token);
  if (session?.user?.jti) revokedSessions.set(session.user.jti, session.user.exp);
}

// Drop revocation entries once the token they block would have expired anyway.
function sweepRevokedSessions() {
  const now = Date.now();
  for (const [jti, exp] of revokedSessions) {
    if (now > exp) revokedSessions.delete(jti);
  }
}

function isSecureRequest(req) {
  if (FORCE_SECURE_COOKIES) return true;
  return Boolean(req.socket?.encrypted) || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function cookieAttributes(req) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  const domain = SESSION_COOKIE_DOMAIN ? `; Domain=${SESSION_COOKIE_DOMAIN}` : '';
  return `${secure}${domain}`;
}

function makeSessionCookie(req, value, expire = false) {
  const attrs = cookieAttributes(req);
  if (expire) return `kasm_session=; HttpOnly; SameSite=Lax; Path=/${attrs}; Max-Age=0`;
  return `kasm_session=${value}; HttpOnly; SameSite=Lax; Path=/${attrs}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function makeStateCookie(req, value, expire = false) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  if (expire) return `kasm_oauth_state=; HttpOnly; SameSite=Lax; Path=/${secure}; Max-Age=0`;
  return `kasm_oauth_state=${value}; HttpOnly; SameSite=Lax; Path=/${secure}; Max-Age=600`;
}

// Cookies belonging to the manager must never reach a desktop container: a
// malicious image could otherwise read an admin session straight off the wire.
const MANAGER_COOKIE_NAMES = ['kasm_session', 'kasm_oauth_state'];

function stripManagerCookies(cookieHeader) {
  if (!cookieHeader) return cookieHeader;
  const kept = String(cookieHeader)
    .split(';')
    .filter((part) => {
      const name = part.split('=')[0].trim();
      return !MANAGER_COOKIE_NAMES.includes(name);
    })
    .map((part) => part.trim())
    .filter(Boolean);
  return kept.length ? kept.join('; ') : null;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const result = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    result[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return result;
}

function timingSafeStringEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

// An upstream gateway can authorize requests instead of GitHub, but only when it
// proves it is the gateway: an unauthenticated header is trivially forged by
// anyone who can reach the app port directly.
function reverseProxyAuthorized(req) {
  if (!ENABLE_REVERSE_PROXY_AUTH) return false;
  if (!REVERSE_PROXY_REQUIRED_VALUE && !REVERSE_PROXY_SHARED_SECRET) return false;
  if (REVERSE_PROXY_SHARED_SECRET &&
      !timingSafeStringEqual(req.headers[REVERSE_PROXY_SECRET_HEADER] || '', REVERSE_PROXY_SHARED_SECRET)) {
    return false;
  }
  const headerValue = req.headers[REVERSE_PROXY_USER_HEADER];
  if (!headerValue) return false;
  if (!REVERSE_PROXY_REQUIRED_VALUE) return true;
  return timingSafeStringEqual(headerValue, REVERSE_PROXY_REQUIRED_VALUE);
}

const REVERSE_PROXY_USER = { login: 'reverse-proxy', name: 'Reverse proxy', email: null, avatarUrl: null };

function currentSession(req) {
  const cookies = parseCookies(req);
  const token = cookies['kasm_session'];
  if (!token) return null;
  return getSession(token);
}

// The identity acting on this request, or null when unauthenticated.
function currentUser(req) {
  const session = currentSession(req);
  if (session) return session.user;
  if (reverseProxyAuthorized(req)) return REVERSE_PROXY_USER;
  if (!GITHUB_AUTH_ENABLED) return { login: 'anonymous', name: 'Anonymous', email: null, avatarUrl: null };
  return null;
}

function isAuthorized(req) {
  return Boolean(currentUser(req));
}

// With no explicit admin list every allowed user is an admin, which keeps the
// single-operator setup working exactly as before.
function isAdminIdentity(login, emails = []) {
  if (!GITHUB_ADMIN_USERS.length) return true;
  const normalizedLogin = String(login || '').toLowerCase();
  const normalizedEmails = emails.map((email) => String(email || '').toLowerCase()).filter(Boolean);
  if (normalizedLogin && GITHUB_ADMIN_USERS.includes(normalizedLogin)) return true;
  return normalizedEmails.some((email) => GITHUB_ADMIN_USERS.includes(email));
}

function isAdmin(req) {
  const user = currentUser(req);
  if (!user) return false;
  if (user.login === 'reverse-proxy' || user.login === 'anonymous') return true;
  return Boolean(user.isAdmin);
}

function ownsInstance(req, instance) {
  if (isAdmin(req)) return true;
  const user = currentUser(req);
  if (!user) return false;
  // Instances created before ownership existed have no owner and stay admin-only.
  return Boolean(instance?.ownerLogin) && instance.ownerLogin === user.login;
}

function visibleInstances(req) {
  if (isAdmin(req)) return getInstances();
  const user = currentUser(req);
  if (!user) return [];
  return getInstances().filter((instance) => instance.ownerLogin === user.login);
}

function isAllowedGitHubIdentity(login, emails) {
  const normalizedLogin = String(login || '').toLowerCase();
  const normalizedEmails = emails.map((email) => String(email || '').toLowerCase()).filter(Boolean);

  // Entries containing "@" are matched against verified emails wherever they are listed,
  // so a single GITHUB_ALLOWED_USERS list can hold both logins and email addresses.
  const allowedLogins = GITHUB_ALLOWED_USERS.filter((entry) => !entry.includes('@'));
  const allowedEmails = [...GITHUB_ALLOWED_EMAILS, ...GITHUB_ALLOWED_USERS.filter((entry) => entry.includes('@'))];

  if (normalizedLogin && allowedLogins.includes(normalizedLogin)) return true;
  return normalizedEmails.some((email) => allowedEmails.includes(email));
}

function hasExplicitAllowList() {
  return Boolean(GITHUB_ALLOWED_USERS.length || GITHUB_ALLOWED_EMAILS.length);
}

// Requests that change state must originate from the manager's own page. Desktop
// containers are same-site under a shared cookie domain, so SameSite alone is not
// enough to stop one from driving the API with the viewer's session.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client; the session cookie is still required
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const selfHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
    return originHost === selfHost;
  } catch {
    return false;
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendBuffer(res, status, body, contentType = 'application/octet-stream', extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  const body = Buffer.isBuffer(text) ? text : Buffer.from(String(text));
  sendBuffer(res, status, body, contentType, extraHeaders);
}

function redirect(res, location, status = 302, extraHeaders = {}) {
  res.writeHead(status, { Location: location, ...extraHeaders });
  res.end();
}

function serveStatic(req, res) {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname.replace(/^\//, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(PUBLIC_DIR, 'index.html');
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };
  sendText(res, 200, fs.readFileSync(filePath), types[ext] || 'application/octet-stream');
}

function readProcCpuTimes() {
  const line = fs.readFileSync('/host/proc/stat', 'utf8').split('\n')[0];
  const nums = line.split(/\s+/).slice(1).map(Number);
  const idle = nums[3] + (nums[4] || 0);
  return { idle, total: nums.reduce((a, b) => a + b, 0) };
}

function parseMemInfo() {
  const kv = {};
  for (const line of fs.readFileSync('/host/proc/meminfo', 'utf8').split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) kv[m[1]] = Number(m[2]) * 1024;
  }
  return kv;
}

async function getHostStats() {
  const t1 = readProcCpuTimes();
  await new Promise((r) => setTimeout(r, 400));
  const t2 = readProcCpuTimes();
  const totalDiff = t2.total - t1.total;
  const idleDiff  = t2.idle  - t1.idle;
  const cpuPct = totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 100) : 0;

  const mem = parseMemInfo();
  const memTotal = mem.MemTotal || 0;
  const memUsed  = memTotal - (mem.MemAvailable || 0);

  const disk = await fs.promises.statfs('/');
  const diskTotal = disk.bsize * disk.blocks;
  const diskUsed  = diskTotal - disk.bsize * disk.bfree;

  return { cpu: cpuPct, memUsed, memTotal, diskUsed, diskTotal };
}

const kasmCache = { repos: null, tags: {}, fetchedAt: 0 };
const KASM_CACHE_TTL = 60 * 60 * 1000;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'kasm-manager/1.0' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Request timed out')));
  });
}

async function fetchKasmRepos() {
  if (kasmCache.repos && Date.now() - kasmCache.fetchedAt < KASM_CACHE_TTL) return kasmCache.repos;
  const repos = [];
  let url = 'https://hub.docker.com/v2/repositories/kasmweb/?page_size=100&ordering=pull_count';
  while (url) {
    const data = await fetchJson(url);
    repos.push(...(data.results || []));
    url = data.next || null;
  }
  kasmCache.repos = repos;
  kasmCache.fetchedAt = Date.now();
  return repos;
}

async function fetchKasmTags(name) {
  const cached = kasmCache.tags[name];
  if (cached && Date.now() - cached.fetchedAt < KASM_CACHE_TTL) return cached.tags;
  const data = await fetchJson(`https://hub.docker.com/v2/repositories/kasmweb/${name}/tags/?page_size=25`);
  const tags = (data.results || [])
    .sort((a, b) => new Date(b.last_updated) - new Date(a.last_updated))
    .slice(0, 10)
    .map((t) => t.name);
  kasmCache.tags[name] = { tags, fetchedAt: Date.now() };
  return tags;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function getProxyTarget(pathname) {
  const match = pathname.match(/^\/(\d+)(\/.*)?$/);
  if (!match) return null;
  const hostPort = Number(match[1]);
  const instance = getInstances().find((item) => Number(item.hostPort) === hostPort);
  if (!instance) return null;
  return {
    instance,
    hostPort,
    prefix: `/${hostPort}`,
    restPath: match[2] || '/',
    rewrite: PROXY_TEXT_REWRITE,
  };
}

function shouldProxy(pathname) {
  return /^\/\d+(?:\/|$)/.test(pathname);
}

function requestHostname(req) {
  return String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0].trim().toLowerCase().split(':')[0];
}

// Hostname mode: each desktop answers on its own hostname, so nothing about the
// response has to be rewritten and each desktop lands on its own browser origin.
function hostnameToPort(hostname) {
  if (!HOSTNAME_MODE || !hostname) return null;
  const [prefix, suffix] = DESKTOP_HOSTNAME_TEMPLATE.split('{port}');
  if (!hostname.startsWith(prefix) || !hostname.endsWith(suffix)) return null;
  const middle = hostname.slice(prefix.length, hostname.length - suffix.length);
  if (!/^\d+$/.test(middle)) return null;
  return Number(middle);
}

function getHostnameProxyTarget(req) {
  const hostPort = hostnameToPort(requestHostname(req));
  if (hostPort === null) return null;
  const instance = getInstances().find((item) => Number(item.hostPort) === hostPort);
  if (!instance) return null;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  return {
    instance,
    hostPort,
    prefix: '',
    restPath: url.pathname || '/',
    rewrite: false, // served at the root of its own hostname — nothing to rewrite
  };
}

function desktopHostnameFor(instance) {
  if (!HOSTNAME_MODE) return null;
  return DESKTOP_HOSTNAME_TEMPLATE.replace('{port}', String(instance.hostPort));
}

// Hop-by-hop headers plus anything that describes a body we are about to replace.
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'content-length', 'content-encoding', 'content-type',
]);

function sanitizeRewrittenHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    result[key] = value;
  }
  return result;
}

function isTextLikeContentType(contentType = '') {
  const value = String(contentType).toLowerCase();
  return value.includes('text/html') ||
    value.includes('application/javascript') ||
    value.includes('text/javascript') ||
    value.includes('text/css') ||
    value.includes('application/json') ||
    value.includes('text/plain');
}

function rewriteLocationHeader(location, prefix) {
  if (!location) return location;
  if (location.startsWith(prefix)) return location;
  if (location.startsWith('/')) return `${prefix}${location}`;
  return location;
}

function rewriteSetCookieHeaders(cookies, prefix) {
  if (!Array.isArray(cookies)) return cookies;
  return cookies.map((cookie) => {
    if (/;\s*path=/i.test(cookie)) {
      return cookie.replace(/;\s*Path=\/([^;]*)/i, (_, tail) => `; Path=${prefix}/${tail || ''}`.replace(/\/+$/,'/'));
    }
    return `${cookie}; Path=${prefix}/`;
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteBodyText(text, prefix, instance, contentType = '') {
  let body = String(text);
  const port = String(instance.hostPort);
  const isHtml = contentType.includes('text/html');
  const isCss = contentType.includes('text/css');

  // Aggressive absolute-path rewriting only safe for HTML/CSS — breaks JS regex literals
  if (isHtml) {
    body = body.replace(/(["'(=])\/(?!\/)/g, `$1${prefix}/`);
  }
  if (isCss) {
    body = body.replace(/url\(\s*\/(?!\/)/g, `url(${prefix}/`);
  }

  // WebSocket path rewrites — safe for all text types
  body = body.replace(/(["'])websockify(["'])/g, `$1${port}/websockify$2`);
  body = body.replace(/(["'])\/websockify(["'])/g, `$1${prefix}/websockify$2`);
  body = body.replace(/path=websockify/g, `path=${port}/websockify`);
  body = body.replace(/path=%2Fwebsockify/g, `path=${encodeURIComponent(`${port}/websockify`)}`);
  body = body.replace(/window\.location\.pathname/g, `"${prefix}" + window.location.pathname`);
  body = body.replace(/"\/vnc\.html/g, `"${prefix}/vnc.html`);
  return body;
}

async function proxyHttpRequest(req, res, target) {
  const { prefix, restPath, hostPort, instance } = target;
  // The manager's own hardening does not belong on a desktop's response — a
  // nosniff we added could break an image that serves assets with a loose type.
  for (const header of ['X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options']) {
    res.removeHeader(header);
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const upstreamPath = restPath + (url.search || '');
  const headers = { ...req.headers };

  delete headers.host;
  delete headers['content-length'];
  delete headers['accept-encoding'];
  delete headers['authorization'];

  // Never hand the manager's own session to a desktop container.
  const forwardedCookies = stripManagerCookies(headers.cookie);
  if (forwardedCookies) headers.cookie = forwardedCookies;
  else delete headers.cookie;

  headers['x-forwarded-host'] = req.headers.host || '';
  if (instance.password) {
    headers['authorization'] = `Basic ${Buffer.from(`${PROXY_UPSTREAM_USER}:${instance.password}`).toString('base64')}`;
  }
  headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : (req.headers['x-forwarded-proto'] || 'http');
  headers['x-forwarded-prefix'] = prefix;
  headers['x-kasm-manager-instance-id'] = instance.id;
  headers['x-kasm-manager-instance-name'] = instance.name;

  const requestOptions = {
    hostname: PROXY_TARGET_HOST,
    port: hostPort,
    method: req.method,
    path: upstreamPath,
    headers,
    ...(PROXY_UPSTREAM_HTTPS ? { rejectUnauthorized: false } : {}),
  };

  const proxyReq = (PROXY_UPSTREAM_HTTPS ? https : http).request(requestOptions, (proxyRes) => {
    const responseHeaders = { ...proxyRes.headers };
    if (responseHeaders.location) responseHeaders.location = rewriteLocationHeader(responseHeaders.location, prefix);
    if (responseHeaders['set-cookie']) responseHeaders['set-cookie'] = rewriteSetCookieHeaders(responseHeaders['set-cookie'], prefix);

    const contentType = String(responseHeaders['content-type'] || '');
    if (target.rewrite && isTextLikeContentType(contentType)) {
      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const original = Buffer.concat(chunks).toString('utf8');
        const rewritten = rewriteBodyText(original, prefix, instance, contentType);
        // The body is ours now: drop every header that described the upstream
        // framing, or the response goes out with both Content-Length and
        // Transfer-Encoding and downstream proxies reject it.
        sendText(res, proxyRes.statusCode || 200, rewritten,
          contentType || 'text/plain; charset=utf-8', sanitizeRewrittenHeaders(responseHeaders));
      });
      return;
    }

    res.writeHead(proxyRes.statusCode || 200, responseHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (error) => {
    sendJson(res, 502, { error: `Proxy request failed for ${prefix}: ${error.message}` });
  });

  req.pipe(proxyReq);
}

function proxyWebSocket(req, socket, head, target) {
  const { prefix, restPath, hostPort, instance } = target;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const requestPath = restPath + (url.search || '');

  const connectFn = PROXY_UPSTREAM_HTTPS
    ? (port, host, cb) => tls.connect({ host, port, rejectUnauthorized: false }, cb)
    : (port, host, cb) => net.connect(port, host, cb);
  const upstream = connectFn(hostPort, PROXY_TARGET_HOST, () => {
    const lines = [];
    lines.push(`GET ${requestPath} HTTP/1.1`);
    lines.push(`Host: ${PROXY_TARGET_HOST}:${hostPort}`);
    for (const [key, value] of Object.entries(req.headers)) {
      const k = key.toLowerCase();
      if (k === 'host' || k === 'authorization') continue;
      if (k === 'cookie') {
        const forwarded = stripManagerCookies(value);
        if (forwarded) lines.push(`cookie: ${forwarded}`);
        continue;
      }
      lines.push(`${key}: ${value}`);
    }
    if (instance.password) {
      lines.push(`authorization: Basic ${Buffer.from(`${PROXY_UPSTREAM_USER}:${instance.password}`).toString('base64')}`);
    }
    lines.push(`x-forwarded-prefix: ${prefix}`);
    lines.push(`x-kasm-manager-instance-id: ${instance.id}`);
    lines.push(`x-kasm-manager-instance-name: ${instance.name}`);
    lines.push('\r\n');
    upstream.write(lines.join('\r\n'));
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on('error', () => {
    try { socket.destroy(); } catch {}
  });
  socket.on('error', () => {
    try { upstream.destroy(); } catch {}
  });
}

async function hydrateInstances(instances = getInstances()) {
  return Promise.all(instances.map(async (instance) => {
    if (!instance.containerId) return presentInstance(instance);
    try {
      return presentInstance(instance, await inspectContainer(instance.containerId));
    } catch {
      return presentInstance({ ...instance, status: 'missing' });
    }
  }));
}

function requestOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (isSecureRequest(req) ? 'https' : 'http');
  const host = (req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

function callbackUrl(req) {
  return GITHUB_CALLBACK_URL || `${requestOrigin(req)}/auth/github/callback`;
}

async function githubPostJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'kasm-desktop-manager',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub responded with ${res.status}`);
  return res.json();
}

async function githubGetJson(url, accessToken) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'kasm-desktop-manager',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub responded with ${res.status}`);
  return res.json();
}

// Org membership scales better than a hand-kept username list and revokes
// access automatically when somebody leaves the org.
async function isOrgMember(accessToken, login) {
  try {
    const membership = await githubGetJson(
      `https://api.github.com/user/memberships/orgs/${encodeURIComponent(GITHUB_ALLOWED_ORG)}`, accessToken);
    if (membership?.state !== 'active') return false;
  } catch {
    return false; // not a member, or the token lacks read:org
  }
  if (!GITHUB_ALLOWED_TEAM) return true;

  try {
    const teams = await githubGetJson('https://api.github.com/user/teams?per_page=100', accessToken);
    return (Array.isArray(teams) ? teams : []).some((team) =>
      String(team?.organization?.login || '').toLowerCase() === GITHUB_ALLOWED_ORG &&
      (String(team?.slug || '').toLowerCase() === GITHUB_ALLOWED_TEAM ||
       String(team?.name || '').toLowerCase() === GITHUB_ALLOWED_TEAM));
  } catch {
    console.warn(`[auth] could not verify team membership for "${login}" — denying`);
    return false;
  }
}

function denyLogin(res, req, message) {
  return redirect(res, `/?auth_error=${encodeURIComponent(message)}`, 302, { 'Set-Cookie': makeStateCookie(req, '', true) });
}

async function handleAuth(req, res, url) {
  if (url.pathname === '/auth/github/login') {
    if (!GITHUB_AUTH_ENABLED) return sendText(res, 503, 'GitHub authentication is not configured.');
    const state = crypto.randomBytes(16).toString('hex');
    const scopes = ['read:user', 'user:email'];
    if (GITHUB_ALLOWED_ORG) scopes.push('read:org');
    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: callbackUrl(req),
      scope: scopes.join(' '),
      state,
      allow_signup: 'false',
    });
    return redirect(res, `https://github.com/login/oauth/authorize?${params.toString()}`, 302, {
      'Set-Cookie': makeStateCookie(req, state),
    });
  }

  if (url.pathname === '/auth/github/callback') {
    if (!GITHUB_AUTH_ENABLED) return sendText(res, 503, 'GitHub authentication is not configured.');

    const cookies = parseCookies(req);
    const expectedState = cookies['kasm_oauth_state'] || '';
    const state = url.searchParams.get('state') || '';
    if (!expectedState || !state || expectedState.length !== state.length ||
        !crypto.timingSafeEqual(Buffer.from(expectedState), Buffer.from(state))) {
      return denyLogin(res, req, 'Login session expired or invalid. Please try again.');
    }

    if (url.searchParams.get('error')) {
      return denyLogin(res, req, url.searchParams.get('error_description') || 'GitHub authorization was denied.');
    }

    const code = url.searchParams.get('code');
    if (!code) return denyLogin(res, req, 'GitHub did not return an authorization code.');

    try {
      const tokenResponse = await githubPostJson('https://github.com/login/oauth/access_token', {
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: callbackUrl(req),
      });
      const accessToken = tokenResponse.access_token;
      if (!accessToken) {
        return denyLogin(res, req, tokenResponse.error_description || 'Could not obtain a GitHub access token.');
      }

      const profile = await githubGetJson('https://api.github.com/user', accessToken);
      let emails = [];
      try {
        const emailList = await githubGetJson('https://api.github.com/user/emails', accessToken);
        emails = (Array.isArray(emailList) ? emailList : [])
          .filter((entry) => entry && entry.verified)
          .map((entry) => entry.email);
      } catch {
        // user:email scope may be unavailable — fall back to the public profile email
        if (profile.email) emails = [profile.email];
      }

      const allowedByList = hasExplicitAllowList() && isAllowedGitHubIdentity(profile.login, emails);
      const allowedByOrg = GITHUB_ALLOWED_ORG
        ? await isOrgMember(accessToken, profile.login)
        : false;

      if (!allowedByList && !allowedByOrg) {
        console.warn(`[auth] denied GitHub login for "${profile.login}" (not in the allow list)`);
        audit(profile.login, 'login.denied', { reason: 'not-allowed' });
        return denyLogin(res, req, `GitHub account "${profile.login}" is not authorized for this manager.`);
      }

      const sessionToken = createSession({
        login: profile.login,
        name: profile.name || profile.login,
        email: emails[0] || profile.email || null,
        avatarUrl: profile.avatar_url || null,
        isAdmin: isAdminIdentity(profile.login, emails),
      });
      console.log(`[auth] GitHub login for "${profile.login}"`);
      audit(profile.login, 'login.success', { via: allowedByList ? 'allow-list' : 'org' });
      return redirect(res, '/', 302, {
        'Set-Cookie': [makeSessionCookie(req, sessionToken), makeStateCookie(req, '', true)],
      });
    } catch (error) {
      console.error('[auth] GitHub login failed:', error.message);
      return denyLogin(res, req, 'GitHub login failed. Please try again.');
    }
  }

  return false;
}

async function handleApi(req, res, url) {
  if (!isAuthorized(req) && !['/api/config'].includes(url.pathname)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  // A desktop container shares this site under a common cookie domain, so
  // SameSite alone would not stop it driving the API with the viewer's session.
  if (req.method !== 'GET' && !originAllowed(req)) {
    return sendJson(res, 403, { error: 'Cross-origin request rejected.' });
  }

  const actor = currentUser(req)?.login || 'anonymous';

  try {
    if (req.method === 'GET' && url.pathname === '/api/me') {
      const user = currentUser(req);
      return sendJson(res, 200, {
        user: user ? { login: user.login, name: user.name, email: user.email, avatarUrl: user.avatarUrl, isAdmin: isAdmin(req) } : null,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/audit') {
      if (!isAdmin(req)) return sendJson(res, 403, { error: 'Admins only.' });
      return sendJson(res, 200, { entries: readAudit(Number(url.searchParams.get('limit')) || 200) });
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const cookies = parseCookies(req);
      if (cookies['kasm_session']) destroySession(cookies['kasm_session']);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': makeSessionCookie(req, '', true) });
    }

    if (req.method === 'GET' && url.pathname === '/api/stats') {
      try {
        return sendJson(res, 200, await getHostStats());
      } catch (err) {
        return sendJson(res, 503, { error: `Stats unavailable: ${err.message}` });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      await pingDocker();
      return sendJson(res, 200, { ok: true, docker: 'reachable' });
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      // Unauthenticated callers only get what the login screen needs.
      const publicConfig = {
        authEnabled: GITHUB_AUTH_ENABLED,
        authProvider: GITHUB_AUTH_ENABLED ? 'github' : 'none',
        loginUrl: '/auth/github/login',
      };
      if (!isAuthorized(req)) return sendJson(res, 200, publicConfig);

      return sendJson(res, 200, {
        ...publicConfig,
        passwordEnvKey: PASSWORD_ENV_KEY,
        defaultInternalPort: DEFAULT_INTERNAL_PORT,
        defaultProfileMountPath: DEFAULT_PROFILE_MOUNT_PATH,
        reverseProxyAuthEnabled: ENABLE_REVERSE_PROXY_AUTH,
        reverseProxyUserHeader: REVERSE_PROXY_USER_HEADER,
        launchAutoconnect: LAUNCH_AUTOCONNECT,
        launchResize: LAUNCH_RESIZE,
        launchIncludePassword: LAUNCH_INCLUDE_PASSWORD,
        proxyTextRewrite: PROXY_TEXT_REWRITE,
        hostnameMode: HOSTNAME_MODE,
        desktopHostnameTemplate: HOSTNAME_MODE ? DESKTOP_HOSTNAME_TEMPLATE : null,
        allowCustomBinds: ALLOW_CUSTOM_BINDS || ALLOWED_BIND_PREFIXES.length > 0,
        allowedNetworkModes: ALLOWED_NETWORK_MODES,
        idleTimeoutMinutes: IDLE_TIMEOUT_MINUTES,
        defaults: {
          cpuLimit: DEFAULT_CPU_LIMIT,
          memoryLimit: DEFAULT_MEMORY_LIMIT,
          shmSize: DEFAULT_SHM_SIZE,
          pidsLimit: DEFAULT_PIDS_LIMIT,
        },
        isAdmin: isAdmin(req),
        portRangeStart: PORT_RANGE_START,
        portRangeEnd: PORT_RANGE_END,
        maxInstances: MAX_INSTANCES,
        instanceCount: visibleInstances(req).length,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/presets') {
      return sendJson(res, 200, { presets: loadPresets() });
    }

    if (req.method === 'GET' && url.pathname === '/api/local-images') {
      return sendJson(res, 200, { images: await listLocalKasmImages() });
    }

    if (req.method === 'DELETE' && url.pathname === '/api/local-images') {
      if (!isAdmin(req)) return sendJson(res, 403, { error: 'Admins only.' });
      const images = await listLocalKasmImages();
      const errors = [];
      for (const img of images) {
        try { await docker(['rmi', `${img.repository}:${img.tag}`]); }
        catch (err) { errors.push(`${img.repository}:${img.tag}: ${err.message}`); }
      }
      audit(actor, 'image.delete-all', { removed: images.length - errors.length });
      return sendJson(res, 200, { removed: images.length - errors.length, errors });
    }

    const localImageDeleteMatch = url.pathname.match(/^\/api\/local-images\/(.+)$/);
    if (req.method === 'DELETE' && localImageDeleteMatch) {
      if (!isAdmin(req)) return sendJson(res, 403, { error: 'Admins only.' });
      const ref = decodeURIComponent(localImageDeleteMatch[1]);
      await docker(['rmi', ref]);
      audit(actor, 'image.delete', { image: ref });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/kasm-images') {
      const repos = await fetchKasmRepos();
      return sendJson(res, 200, {
        images: repos.map((r) => ({ name: r.name, description: r.short_description || '' })),
      });
    }

    const kasmTagsMatch = url.pathname.match(/^\/api\/kasm-images\/([^/]+)\/tags$/);
    if (req.method === 'GET' && kasmTagsMatch) {
      const tags = await fetchKasmTags(kasmTagsMatch[1]);
      return sendJson(res, 200, { tags });
    }

    if (req.method === 'GET' && url.pathname === '/api/ports') {
      return sendJson(res, 200, { usedPorts: await listUsedHostPorts() });
    }

    if (req.method === 'GET' && url.pathname === '/api/instances') {
      return sendJson(res, 200, { instances: await hydrateInstances(visibleInstances(req)) });
    }

    const launchMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/launch$/);
    if (req.method === 'POST' && launchMatch) {
      const instance = getInstance(launchMatch[1]);
      if (!instance || !ownsInstance(req, instance)) return sendJson(res, 404, { error: 'Instance not found.' });
      const token = createLaunchToken(instance.id);
      audit(actor, 'instance.launch', { instanceId: instance.id, name: instance.name });
      return sendJson(res, 200, { launchPath: `/launch/${instance.id}?t=${token}`, instance: presentInstance(instance) });
    }

    const logsMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/logs$/);
    if (req.method === 'GET' && logsMatch) {
      const instance = getInstance(logsMatch[1]);
      if (!instance || !ownsInstance(req, instance)) return sendJson(res, 404, { error: 'Instance not found.' });
      if (!instance.containerId) return sendJson(res, 409, { error: 'This desktop has no container yet.' });
      const tail = Math.min(Number(url.searchParams.get('tail')) || 200, 2000);
      return sendJson(res, 200, { logs: await containerLogs(instance.containerId, tail) });
    }

    const statsMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/stats$/);
    if (req.method === 'GET' && statsMatch) {
      const instance = getInstance(statsMatch[1]);
      if (!instance || !ownsInstance(req, instance)) return sendJson(res, 404, { error: 'Instance not found.' });
      if (!instance.containerId) return sendJson(res, 409, { error: 'This desktop has no container yet.' });
      return sendJson(res, 200, { stats: await containerStats(instance.containerId) });
    }

    // Revealing a desktop password is an explicit, audited action.
    const passwordMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/password$/);
    if (req.method === 'GET' && passwordMatch) {
      const instance = getInstance(passwordMatch[1]);
      if (!instance || !ownsInstance(req, instance)) return sendJson(res, 404, { error: 'Instance not found.' });
      audit(actor, 'instance.password.reveal', { instanceId: instance.id, name: instance.name });
      return sendJson(res, 200, { password: instance.password || null });
    }

    if (req.method === 'POST' && url.pathname === '/api/instances') {
      const body = await readBody(req);
      const { name, image, presetName, password, hostPort, internalPort, networkMode, extraEnv, binds,
              persistentProfile, profileMountPath, cpuLimit, memoryLimit, shmSize, pidsLimit } = body || {};
      const presets = loadPresets();
      const preset = presetName ? presets.find((item) => item.name === presetName) : null;
      const resolvedImage = image || preset?.image;
      const resolvedInternalPort = internalPort || preset?.internalPort || DEFAULT_INTERNAL_PORT;
      const resolvedNetworkMode = networkMode || preset?.networkMode || DEFAULT_NETWORK_MODE;
      const resolvedProfileMountPath = profileMountPath || preset?.profileMountPath || DEFAULT_PROFILE_MOUNT_PATH;
      const resolvedExtraEnv = [...(preset?.extraEnv || []), ...sanitizeExtraEnv(extraEnv)];
      // Preset binds are operator-authored and trusted; only request binds are checked.
      const requestBinds = sanitizeStringArray(binds);
      const resolvedBinds = [...(preset?.binds || []), ...requestBinds];

      if (!name || !resolvedImage || !password) {
        return sendJson(res, 400, { error: 'name, image or presetName, and password are required.' });
      }

      try {
        validateBinds(requestBinds);
        validateNetworkMode(resolvedNetworkMode);
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }

      if (getInstances().length >= MAX_INSTANCES) {
        return sendJson(res, 409, { error: `Instance limit reached (${MAX_INSTANCES}). Delete an existing desktop to create a new one.` });
      }

      // Port selection and the store write happen under one lock, so two
      // simultaneous creates cannot be handed the same host port.
      let instance;
      try {
        instance = await withStoreLock(async () => {
          let numericPort;
          if (hostPort) {
            numericPort = Number(hostPort);
            if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
              throw Object.assign(new Error('hostPort must be a valid TCP port.'), { status: 400 });
            }
            const conflict = getInstances().find((item) => Number(item.hostPort) === numericPort);
            if (conflict) throw Object.assign(new Error(`Port ${numericPort} is already assigned to "${conflict.name}".`), { status: 409 });
            if ((await listUsedHostPorts()).includes(numericPort)) {
              throw Object.assign(new Error(`Port ${numericPort} is already in use on the Docker host.`), { status: 409 });
            }
          } else {
            numericPort = await findAvailablePort();
          }

          const id = crypto.randomUUID().slice(0, 10);
          const created = {
            id,
            name: String(name).trim(),
            slug: `${slugify(name)}-${id.toLowerCase()}`,
            image: String(resolvedImage).trim(),
            password: String(password),
            hostPort: numericPort,
            internalPort: String(resolvedInternalPort),
            networkMode: String(resolvedNetworkMode),
            extraEnv: resolvedExtraEnv,
            binds: resolvedBinds,
            persistentProfile: Boolean(persistentProfile),
            profileMountPath: String(resolvedProfileMountPath),
            profileVolumeName: Boolean(persistentProfile) ? `${PROFILE_VOLUME_PREFIX}${slugify(name)}-${id.toLowerCase()}` : null,
            cpuLimit: cpuLimit ? String(cpuLimit) : '',
            memoryLimit: memoryLimit ? String(memoryLimit) : '',
            shmSize: shmSize ? String(shmSize) : '',
            pidsLimit: pidsLimit ? String(pidsLimit) : '',
            ownerLogin: currentUser(req)?.login || null,
            createdAt: new Date().toISOString(),
            status: 'pulling',
            containerId: null,
          };
          saveInstance(created);
          return created;
        });
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message });
      }

      audit(actor, 'instance.create', { instanceId: instance.id, name: instance.name, image: instance.image, hostPort: instance.hostPort });
      sendJson(res, 202, { instance: presentInstance(instance) });

      // Pull image and start container in the background
      setImmediate(async () => {
        try {
          await imagePull(instance.image);
          updateInstance(instance.id, (i) => ({ ...i, status: 'creating' }));
          const inspect = await createAndStart(instance, { skipPull: true });
          updateInstance(instance.id, (i) => ({
            ...i,
            containerId: inspect.Id,
            status: inspect.State?.Status || 'running',
            error: null,
          }));
        } catch (err) {
          updateInstance(instance.id, (i) => ({ ...i, status: 'error', error: err.message }));
        }
      });
      return;
    }

    const match = url.pathname.match(/^\/api\/instances\/([^/]+)(?:\/(start|stop|reset))?$/);
    if (match) {
      const [, id, action] = match;
      const instance = getInstance(id);
      // A desktop somebody else owns is indistinguishable from one that is gone.
      if (!instance || !ownsInstance(req, instance)) return sendJson(res, 404, { error: 'Instance not found.' });

      if (req.method === 'POST' && action === 'start') {
        if (!instance.containerId) return sendJson(res, 404, { error: 'Instance not found.' });
        const inspect = await startContainer(instance.containerId);
        const updated = updateInstance(instance.id, (item) => ({ ...item, status: inspect.State?.Status || 'running' }));
        markActive(instance.id);
        audit(actor, 'instance.start', { instanceId: instance.id, name: instance.name });
        return sendJson(res, 200, { instance: presentInstance(updated, inspect) });
      }

      if (req.method === 'POST' && action === 'stop') {
        if (!instance.containerId) return sendJson(res, 404, { error: 'Instance not found.' });
        const inspect = await stopContainer(instance.containerId);
        const updated = updateInstance(instance.id, (item) => ({ ...item, status: inspect.State?.Status || 'exited' }));
        audit(actor, 'instance.stop', { instanceId: instance.id, name: instance.name });
        return sendJson(res, 200, { instance: presentInstance(updated, inspect) });
      }

      if (req.method === 'POST' && action === 'reset') {
        const body = await readBody(req);
        const clearProfile = Boolean(body?.clearProfile);
        const inspect = await recreateInstance(instance, { clearProfile });
        const updated = updateInstance(instance.id, (item) => ({ ...item, containerId: inspect.Id, status: inspect.State?.Status || 'running', resetAt: new Date().toISOString(), error: null }));
        audit(actor, 'instance.reset', { instanceId: instance.id, name: instance.name, clearProfile });
        return sendJson(res, 200, { instance: presentInstance(updated, inspect) });
      }

      if (req.method === 'DELETE' && !action) {
        if (instance.containerId) {
          try { await removeContainer(instance.containerId, true); } catch {}
        } else {
          const existingId = await findContainerByInstanceId(instance.id);
          if (existingId) try { await removeContainer(existingId, true); } catch {}
        }
        const removeProfile = url.searchParams.get('removeProfile') === 'true' && instance.persistentProfile;
        if (removeProfile) {
          try { await removeProfileVolume(instance); } catch {}
        }
        removeInstance(instance.id);
        activity.delete(instance.id);
        audit(actor, 'instance.delete', { instanceId: instance.id, name: instance.name, removeProfile });
        return sendJson(res, 200, { ok: true });
      }
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Internal server error' });
  }
}

async function handleLaunch(req, res, url) {
  const match = url.pathname.match(/^\/launch\/([^/]+)$/);
  if (!match) return false;
  if (!isAuthorized(req)) return redirect(res, '/');

  const instanceId = match[1];
  const token = url.searchParams.get('t');
  // A one-time token authorizes a single launch on its own; without one the
  // caller must be signed in and own the desktop. Reusing a spent token simply
  // falls back to the session check, so refreshing the tab still works.
  const authorizedByToken = Boolean(token) && consumeLaunchToken(token) === instanceId;

  if (!authorizedByToken && !isAuthorized(req)) return redirect(res, '/');

  const instance = getInstance(instanceId);
  if (!instance) return sendText(res, 404, 'Instance not found');
  if (!authorizedByToken && !ownsInstance(req, instance)) return sendText(res, 404, 'Instance not found');

  markActive(instance.id);
  const protocol = isSecureRequest(req) ? 'https' : 'http';
  return redirect(res, buildLaunchUrl(instance, { protocol }));
}

// The manager's own pages; desktop responses are passed through untouched.
function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Hostname mode: this request belongs to a desktop, not to the manager UI.
  const hostnameTarget = getHostnameProxyTarget(req);
  if (hostnameTarget) {
    if (!isAuthorized(req)) return redirect(res, '/');
    if (!ownsInstance(req, hostnameTarget.instance)) return sendText(res, 404, 'Instance not found');
    markActive(hostnameTarget.instance.id);
    return proxyHttpRequest(req, res, hostnameTarget);
  }

  applySecurityHeaders(res);

  if (url.pathname.startsWith('/auth/')) {
    const authHandled = await handleAuth(req, res, url);
    if (authHandled !== false) return;
  }

  const launchHandled = await handleLaunch(req, res, url);
  if (launchHandled !== false) return;

  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);

  if (!HOSTNAME_MODE && shouldProxy(url.pathname)) {
    if (!isAuthorized(req)) return redirect(res, '/');
    const target = getProxyTarget(url.pathname);
    if (!target) return sendText(res, 404, 'Managed instance not found for this path.');
    if (!ownsInstance(req, target.instance)) return sendText(res, 404, 'Managed instance not found for this path.');
    markActive(target.instance.id);
    if (url.pathname === target.prefix || url.pathname === `${target.prefix}/`) {
      return redirect(res, buildLaunchUrl(target.instance));
    }
    return proxyHttpRequest(req, res, target);
  }

  const publicPaths = ['/', '/index.html', '/app.js', '/styles.css'];
  if (!isAuthorized(req) && !publicPaths.includes(url.pathname)) {
    return redirect(res, '/');
  }

  return serveStatic(req, res);
});

server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const target = getHostnameProxyTarget(req) || (!HOSTNAME_MODE && shouldProxy(url.pathname) ? getProxyTarget(url.pathname) : null);
    if (!target) {
      socket.destroy();
      return;
    }
    if (!isAuthorized(req) || !ownsInstance(req, target.instance)) {
      socket.destroy();
      return;
    }
    markActive(target.instance.id);
    proxyWebSocket(req, socket, head, target);
  } catch {
    try { socket.destroy(); } catch {}
  }
});

// ── Background maintenance ────────────────────────────────

// A restart leaves any in-flight create stranded in "pulling"/"creating"; adopt
// the container if it actually came up, and mark the rest as failed.
async function reconcileOnBoot() {
  for (const instance of getInstances()) {
    if (!['pulling', 'creating'].includes(instance.status)) continue;
    try {
      const containerId = await findContainerByInstanceId(instance.id);
      if (containerId) {
        const inspect = await inspectContainer(containerId);
        updateInstance(instance.id, (item) => ({
          ...item,
          containerId,
          status: inspect?.State?.Status || 'running',
          error: null,
        }));
        console.log(`[boot] adopted container for "${instance.name}"`);
      } else {
        updateInstance(instance.id, (item) => ({
          ...item,
          status: 'error',
          error: 'The manager restarted while this desktop was being created. Reset it to try again.',
        }));
        console.warn(`[boot] "${instance.name}" was interrupted mid-create`);
      }
    } catch (error) {
      console.warn(`[boot] could not reconcile "${instance.name}": ${error.message}`);
    }
  }
}

async function reapIdleInstances() {
  if (IDLE_TIMEOUT_MINUTES <= 0) return;
  const cutoff = Date.now() - IDLE_TIMEOUT_MINUTES * 60 * 1000;
  for (const instance of getInstances()) {
    if (instance.status !== 'running' || !instance.containerId) continue;
    const lastActive = activity.get(instance.id);
    // Never reap a desktop we have not seen used since boot; give it one window.
    if (!lastActive) { markActive(instance.id); continue; }
    if (lastActive > cutoff) continue;
    try {
      await stopContainer(instance.containerId);
      updateInstance(instance.id, (item) => ({ ...item, status: 'exited' }));
      audit('system', 'instance.idle-stop', { instanceId: instance.id, name: instance.name, idleMinutes: IDLE_TIMEOUT_MINUTES });
      console.log(`[idle] stopped "${instance.name}" after ${IDLE_TIMEOUT_MINUTES} idle minutes`);
    } catch (error) {
      console.warn(`[idle] could not stop "${instance.name}": ${error.message}`);
    }
  }
}

function startBackgroundJobs() {
  const maintenance = setInterval(() => {
    sweepRevokedSessions();
    sweepLaunchTokens();
    reapIdleInstances().catch(() => {});
  }, 60_000);
  maintenance.unref?.();
  return maintenance;
}

function start() {
  server.listen(PORT, () => {
    console.log(`Kasm manager listening on port ${PORT}`);
    if (HOSTNAME_MODE) console.log(`[proxy] hostname mode active: ${DESKTOP_HOSTNAME_TEMPLATE}`);
  });
  startBackgroundJobs();
  reconcileOnBoot().catch((error) => console.warn(`[boot] reconcile failed: ${error.message}`));
  return server;
}

if (require.main === module) start();

// Exported for the test suite; the server only listens when run directly.
module.exports = {
  server,
  start,
  isAllowedGitHubIdentity,
  isAdminIdentity,
  stripManagerCookies,
  sanitizeRewrittenHeaders,
  createSession,
  getSession,
  destroySession,
  createLaunchToken,
  consumeLaunchToken,
  hostnameToPort,
  validateBinds,
  validateNetworkMode,
  buildRunArgs,
  parseAllowList,
  writeStore,
  readStore,
};
