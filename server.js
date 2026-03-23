
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
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ENABLE_REVERSE_PROXY_AUTH = String(process.env.ENABLE_REVERSE_PROXY_AUTH || 'false').toLowerCase() === 'true';
const REVERSE_PROXY_USER_HEADER = (process.env.REVERSE_PROXY_USER_HEADER || 'x-forwarded-user').toLowerCase();
const REVERSE_PROXY_REQUIRED_VALUE = process.env.REVERSE_PROXY_REQUIRED_VALUE || '';
const PASSWORD_ENV_KEY = process.env.PASSWORD_ENV_KEY || 'VNC_PW';
const DEFAULT_INTERNAL_PORT = process.env.DEFAULT_INTERNAL_PORT || '6901/tcp';
const DEFAULT_NETWORK_MODE = process.env.DEFAULT_NETWORK_MODE || 'bridge';
const DEFAULT_PROFILE_MOUNT_PATH = process.env.DEFAULT_PROFILE_MOUNT_PATH || '/home/kasm-user';
const INSTANCE_NAME_PREFIX = process.env.INSTANCE_NAME_PREFIX || 'kasm-desktop-';
const PROFILE_VOLUME_PREFIX = process.env.PROFILE_VOLUME_PREFIX || 'kasm-profile-';
const MANAGED_LABEL = process.env.MANAGED_LABEL || 'com.egli.kasm-manager.managed';
const DATA_FILE = process.env.DATA_FILE || path.join(rootDir, 'data', 'instances.json');
const IMAGE_PRESETS_FILE = process.env.IMAGE_PRESETS_FILE || path.join(rootDir, 'data', 'image-presets.json');
const PUBLIC_DIR = path.join(rootDir, 'public');
const PROXY_TARGET_HOST = process.env.PROXY_TARGET_HOST || 'host.docker.internal';
const PROXY_UPSTREAM_HTTPS = String(process.env.PROXY_UPSTREAM_HTTPS || 'true').toLowerCase() === 'true';
const PROXY_UPSTREAM_USER = process.env.PROXY_UPSTREAM_USER || 'kasm_user';
const PROXY_TEXT_REWRITE = String(process.env.PROXY_TEXT_REWRITE || 'true').toLowerCase() === 'true';
const LAUNCH_AUTOCONNECT = String(process.env.LAUNCH_AUTOCONNECT || 'true').toLowerCase() === 'true';
const PORT_RANGE_START = Number(process.env.PORT_RANGE_START || 6901);
const PORT_RANGE_END   = Number(process.env.PORT_RANGE_END   || 6999);
const MAX_INSTANCES    = Number(process.env.MAX_INSTANCES    || 10);
const LAUNCH_RESIZE = process.env.LAUNCH_RESIZE || 'remote';
const LAUNCH_VIEW_ONLY = String(process.env.LAUNCH_VIEW_ONLY || 'false').toLowerCase() === 'true';
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const CLOUDFLARE_API_KEY = process.env.CLOUDFLARE_API_KEY || '';
const CLOUDFLARE_EMAIL = process.env.CLOUDFLARE_EMAIL || '';
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID || '';
const CLOUDFLARE_TUNNEL_ID = process.env.CLOUDFLARE_TUNNEL_ID || '';
const CLOUDFLARE_BASE_DOMAIN = String(process.env.CLOUDFLARE_BASE_DOMAIN || '').trim().toLowerCase();
const CLOUDFLARE_TUNNEL_SERVICE_HOST = process.env.CLOUDFLARE_TUNNEL_SERVICE_HOST || 'host.docker.internal';
const CLOUDFLARE_DNS_PROXIED = String(process.env.CLOUDFLARE_DNS_PROXIED || 'true').toLowerCase() === 'true';
const CLOUDFLARE_TUNNEL_SERVICE_SCHEME = String(process.env.CLOUDFLARE_TUNNEL_SERVICE_SCHEME || 'https').toLowerCase();
const CLOUDFLARE_TUNNEL_NO_TLS_VERIFY = String(process.env.CLOUDFLARE_TUNNEL_NO_TLS_VERIFY || 'true').toLowerCase() === 'true';

ensureStore();

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

function readStore() {
  ensureStore();
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(raw.instances) ? raw : { instances: [] };
  } catch {
    return { instances: [] };
  }
}

function writeStore(payload) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
}

function getInstances() {
  return readStore().instances || [];
}

function getInstance(id) {
  return getInstances().find((item) => item.id === id) || null;
}

function saveInstance(instance) {
  const store = readStore();
  const idx = store.instances.findIndex((item) => item.id === instance.id);
  if (idx >= 0) store.instances[idx] = instance;
  else store.instances.push(instance);
  writeStore(store);
  return instance;
}

function updateInstance(id, updater) {
  const store = readStore();
  const idx = store.instances.findIndex((item) => item.id === id);
  if (idx === -1) return null;
  store.instances[idx] = updater(store.instances[idx]);
  writeStore(store);
  return store.instances[idx];
}

function removeInstance(id) {
  const store = readStore();
  store.instances = store.instances.filter((item) => item.id !== id);
  writeStore(store);
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
    const { stdout, stderr } = await execFileAsync('docker', args, { maxBuffer: 10 * 1024 * 1024, ...options });
    return { stdout, stderr };
  } catch (error) {
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
  await docker(['pull', image]);
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

function buildLaunchUrl(instance) {
  const prefix = `/${instance.hostPort}`;
  const params = new URLSearchParams();
  if (LAUNCH_AUTOCONNECT) params.set('autoconnect', '1');
  if (instance.password) params.set('password', instance.password);
  if (LAUNCH_RESIZE) params.set('resize', LAUNCH_RESIZE);
  params.set('path', `${instance.hostPort}/websockify`);
  params.set('reconnect', '1');
  if (LAUNCH_VIEW_ONLY) params.set('view_only', '1');
  return `${prefix}/vnc.html?${params.toString()}`;
}

function presentInstance(instance, inspect = null) {
  const state = inspect?.State?.Status || instance.status || 'unknown';
  return {
    ...instance,
    state,
    containerId: inspect?.Id || instance.containerId || null,
    startedAt: inspect?.State?.StartedAt || null,
    finishedAt: inspect?.State?.FinishedAt || null,
    ports: inspect?.NetworkSettings?.Ports || null,
    launchUrl: buildLaunchUrl(instance),
    pathPrefix: `/${instance.hostPort}`,
    cloudflare: {
      published: Boolean(instance.cloudflare?.published),
      hostname: instance.cloudflare?.hostname || null,
      routeCreatedAt: instance.cloudflare?.routeCreatedAt || null,
      dnsCreatedAt: instance.cloudflare?.dnsCreatedAt || null,
      lastPublishedAt: instance.cloudflare?.lastPublishedAt || null,
      lastError: instance.cloudflare?.lastError || null,
    },
  };
}

function cloudflareConfigured() {
  const hasAuth = Boolean(CLOUDFLARE_API_TOKEN) || (Boolean(CLOUDFLARE_API_KEY) && Boolean(CLOUDFLARE_EMAIL));
  return hasAuth && Boolean(CLOUDFLARE_ACCOUNT_ID) && Boolean(CLOUDFLARE_ZONE_ID) && Boolean(CLOUDFLARE_TUNNEL_ID) && Boolean(CLOUDFLARE_BASE_DOMAIN);
}

function cloudflareAuthHeaders() {
  if (CLOUDFLARE_API_TOKEN) return { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` };
  if (CLOUDFLARE_API_KEY && CLOUDFLARE_EMAIL) {
    return { 'X-Auth-Key': CLOUDFLARE_API_KEY, 'X-Auth-Email': CLOUDFLARE_EMAIL };
  }
  throw new Error('Cloudflare credentials are not configured.');
}

function normalizeHostname(value) {
  return String(value || '').trim().toLowerCase().replace(/\.+$/, '');
}

function isAllowedCloudflareHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  if (!normalized || !CLOUDFLARE_BASE_DOMAIN) return false;
  return normalized === CLOUDFLARE_BASE_DOMAIN || normalized.endsWith(`.${CLOUDFLARE_BASE_DOMAIN}`);
}

function resolvePublishHostname(instance, requestedHostname = '') {
  const candidate = requestedHostname || `${instance.slug}.${CLOUDFLARE_BASE_DOMAIN}`;
  const hostname = normalizeHostname(candidate);
  if (!hostname) throw new Error('A hostname is required to publish this instance.');
  if (!isAllowedCloudflareHostname(hostname)) {
    throw new Error(`Hostname must be under the allowed base domain (${CLOUDFLARE_BASE_DOMAIN}).`);
  }
  return hostname;
}

function buildTunnelServiceUrl(instance) {
  const scheme = CLOUDFLARE_TUNNEL_SERVICE_SCHEME === 'http' ? 'http' : 'https';
  return `${scheme}://${CLOUDFLARE_TUNNEL_SERVICE_HOST}:${Number(instance.hostPort)}`;
}

async function cloudflareRequest(method, endpoint, body = undefined) {
  const url = `https://api.cloudflare.com/client/v4${endpoint}`;
  const headers = { 'Content-Type': 'application/json', ...cloudflareAuthHeaders() };
  const response = await fetch(url, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    const detail = errors.length
      ? errors.map((item) => item?.message || JSON.stringify(item)).join('; ')
      : (Array.isArray(payload?.messages) ? payload.messages.join('; ') : '');
    throw new Error(`Cloudflare API error (${response.status}): ${detail || 'Request failed'}`);
  }
  return payload.result;
}

function isCloudflareNotFound(error) {
  const text = String(error?.message || '');
  return /404|not found|does not exist/i.test(text);
}

async function getTunnelIngress() {
  const result = await cloudflareRequest('GET', `/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${CLOUDFLARE_TUNNEL_ID}/configurations`);
  const config = result?.config || {};
  const ingress = Array.isArray(config.ingress) ? config.ingress : [];
  return { config, ingress };
}

function ensureCatchAllIngress(ingress = []) {
  const rules = Array.isArray(ingress) ? [...ingress] : [];
  const hasCatchAll = rules.some((rule) => !rule?.hostname && Boolean(rule?.service));
  if (!hasCatchAll) rules.push({ service: 'http_status:404' });
  return rules;
}

async function saveTunnelIngress(config, ingress) {
  return cloudflareRequest('PUT', `/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${CLOUDFLARE_TUNNEL_ID}/configurations`, {
    config: { ...config, ingress: ensureCatchAllIngress(ingress) },
  });
}

async function upsertTunnelRoute(hostname, service) {
  const { config, ingress } = await getTunnelIngress();
  const nextIngress = ingress.filter((rule) => normalizeHostname(rule?.hostname) !== hostname);
  nextIngress.unshift({
    hostname,
    service,
    originRequest: {
      noTLSVerify: CLOUDFLARE_TUNNEL_NO_TLS_VERIFY,
    },
  });
  await saveTunnelIngress(config, nextIngress);
}

async function deleteTunnelRoute(hostname) {
  const { config, ingress } = await getTunnelIngress();
  const nextIngress = ingress.filter((rule) => normalizeHostname(rule?.hostname) !== hostname);
  await saveTunnelIngress(config, nextIngress);
}

async function upsertTunnelDnsRecord(hostname) {
  const existing = await cloudflareRequest(
    'GET',
    `/zones/${CLOUDFLARE_ZONE_ID}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}&per_page=1`,
  );
  const target = `${CLOUDFLARE_TUNNEL_ID}.cfargotunnel.com`;
  if (Array.isArray(existing) && existing[0]) {
    const record = existing[0];
    await cloudflareRequest('PUT', `/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${record.id}`, {
      type: 'CNAME',
      name: hostname,
      content: target,
      proxied: CLOUDFLARE_DNS_PROXIED,
      ttl: 1,
    });
    return record.id;
  }
  const created = await cloudflareRequest('POST', `/zones/${CLOUDFLARE_ZONE_ID}/dns_records`, {
    type: 'CNAME',
    name: hostname,
    content: target,
    proxied: CLOUDFLARE_DNS_PROXIED,
    ttl: 1,
  });
  return created?.id || null;
}

async function deleteTunnelDnsRecord(hostname, knownRecordId = null) {
  if (knownRecordId) {
    try {
      await cloudflareRequest('DELETE', `/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${knownRecordId}`);
      return;
    } catch (error) {
      if (!isCloudflareNotFound(error)) throw error;
    }
  }

  const records = await cloudflareRequest(
    'GET',
    `/zones/${CLOUDFLARE_ZONE_ID}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}&per_page=50`,
  );
  for (const record of records || []) {
    try {
      await cloudflareRequest('DELETE', `/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${record.id}`);
    } catch (error) {
      if (!isCloudflareNotFound(error)) throw error;
    }
  }
}

async function publishInstanceCloudflare(instance, requestedHostname = '') {
  if (!cloudflareConfigured()) throw new Error('Cloudflare publishing is not configured on this server.');
  const hostname = resolvePublishHostname(instance, requestedHostname);
  const service = buildTunnelServiceUrl(instance);
  await upsertTunnelRoute(hostname, service);
  let dnsRecordId = null;
  try {
    dnsRecordId = await upsertTunnelDnsRecord(hostname);
  } catch (error) {
    // Best-effort rollback so we do not leave a route without DNS.
    await deleteTunnelRoute(hostname).catch(() => {});
    throw error;
  }
  const now = new Date().toISOString();
  return {
    published: true,
    hostname,
    service,
    dnsRecordId,
    routeCreatedAt: now,
    dnsCreatedAt: now,
    lastPublishedAt: now,
    lastError: null,
  };
}

async function unpublishInstanceCloudflare(instance) {
  const cf = instance?.cloudflare || {};
  const hostname = normalizeHostname(cf.hostname);
  if (!hostname) {
    return {
      published: false,
      hostname: null,
      service: null,
      dnsRecordId: null,
      routeCreatedAt: null,
      dnsCreatedAt: null,
      lastPublishedAt: cf.lastPublishedAt || null,
      lastError: null,
    };
  }
  await deleteTunnelRoute(hostname).catch((error) => {
    if (!isCloudflareNotFound(error)) throw error;
  });
  await deleteTunnelDnsRecord(hostname, cf.dnsRecordId || null).catch((error) => {
    if (!isCloudflareNotFound(error)) throw error;
  });
  return {
    published: false,
    hostname: null,
    service: null,
    dnsRecordId: null,
    routeCreatedAt: null,
    dnsCreatedAt: null,
    lastPublishedAt: cf.lastPublishedAt || null,
    lastError: null,
  };
}

const sessions = new Map();

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { createdAt: Date.now() });
  return token;
}

function destroySession(token) {
  sessions.delete(token);
}

function isSecureRequest(req) {
  return req.socket?.encrypted || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function makeSessionCookie(req, value, expire = false) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  if (expire) return `kasm_session=; HttpOnly; SameSite=Lax; Path=/${secure}; Max-Age=0`;
  return `kasm_session=${value}; HttpOnly; SameSite=Lax; Path=/${secure}`;
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

function reverseProxyAuthorized(req) {
  if (!ENABLE_REVERSE_PROXY_AUTH) return false;
  const headerValue = req.headers[REVERSE_PROXY_USER_HEADER];
  if (!headerValue) return false;
  if (!REVERSE_PROXY_REQUIRED_VALUE) return true;
  return headerValue === REVERSE_PROXY_REQUIRED_VALUE;
}

function isAuthorized(req) {
  if (reverseProxyAuthorized(req)) return true;
  if (!ADMIN_PASSWORD) return true;
  const cookies = parseCookies(req);
  return cookies['kasm_session'] && sessions.has(cookies['kasm_session']);
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

function redirect(res, location, status = 302) {
  res.writeHead(status, { Location: location });
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
  const cacheHeaders = {
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  };
  sendText(res, 200, fs.readFileSync(filePath), types[ext] || 'application/octet-stream', cacheHeaders);
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
  };
}

function shouldProxy(pathname) {
  return /^\/\d+(?:\/|$)/.test(pathname);
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
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const upstreamPath = restPath + (url.search || '');
  const headers = { ...req.headers };

  delete headers.host;
  delete headers['content-length'];
  delete headers['accept-encoding'];
  delete headers['authorization'];
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
    if (PROXY_TEXT_REWRITE && isTextLikeContentType(contentType)) {
      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const original = Buffer.concat(chunks).toString('utf8');
        const rewritten = rewriteBodyText(original, prefix, instance, contentType);
        delete responseHeaders['content-length'];
        sendText(res, proxyRes.statusCode || 200, rewritten, contentType || 'text/plain; charset=utf-8', responseHeaders);
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

async function hydrateInstances() {
  return Promise.all(getInstances().map(async (instance) => {
    if (!instance.containerId) return presentInstance(instance);
    try {
      return presentInstance(instance, await inspectContainer(instance.containerId));
    } catch {
      return presentInstance({ ...instance, status: 'missing' });
    }
  }));
}

async function handleApi(req, res, url) {
  if (!isAuthorized(req) && !['/api/config', '/api/login'].includes(url.pathname)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  try {
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const body = await readBody(req);
      if (!ADMIN_PASSWORD || (body.username === ADMIN_USERNAME && body.password === ADMIN_PASSWORD)) {
        const sessionToken = createSession();
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': makeSessionCookie(req, sessionToken) });
      }
      return sendJson(res, 401, { error: 'Invalid username or password' });
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
      return sendJson(res, 200, {
        passwordEnvKey: PASSWORD_ENV_KEY,
        defaultInternalPort: DEFAULT_INTERNAL_PORT,
        defaultProfileMountPath: DEFAULT_PROFILE_MOUNT_PATH,
        authEnabled: Boolean(ADMIN_PASSWORD),
        reverseProxyAuthEnabled: ENABLE_REVERSE_PROXY_AUTH,
        reverseProxyUserHeader: REVERSE_PROXY_USER_HEADER,
        launchAutoconnect: LAUNCH_AUTOCONNECT,
        launchResize: LAUNCH_RESIZE,
        proxyTextRewrite: PROXY_TEXT_REWRITE,
        portRangeStart: PORT_RANGE_START,
        portRangeEnd: PORT_RANGE_END,
        maxInstances: MAX_INSTANCES,
        instanceCount: getInstances().length,
        cloudflareConfigured: cloudflareConfigured(),
        cloudflareBaseDomain: CLOUDFLARE_BASE_DOMAIN || null,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/presets') {
      return sendJson(res, 200, { presets: loadPresets() });
    }

    if (req.method === 'GET' && url.pathname === '/api/local-images') {
      return sendJson(res, 200, { images: await listLocalKasmImages() });
    }

    if (req.method === 'DELETE' && url.pathname === '/api/local-images') {
      const images = await listLocalKasmImages();
      const errors = [];
      for (const img of images) {
        try { await docker(['rmi', `${img.repository}:${img.tag}`]); }
        catch (err) { errors.push(`${img.repository}:${img.tag}: ${err.message}`); }
      }
      return sendJson(res, 200, { removed: images.length - errors.length, errors });
    }

    const localImageDeleteMatch = url.pathname.match(/^\/api\/local-images\/(.+)$/);
    if (req.method === 'DELETE' && localImageDeleteMatch) {
      const ref = decodeURIComponent(localImageDeleteMatch[1]);
      await docker(['rmi', ref]);
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
      return sendJson(res, 200, { instances: await hydrateInstances() });
    }

    const launchMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/launch$/);
    if (req.method === 'GET' && launchMatch) {
      const instance = getInstance(launchMatch[1]);
      if (!instance) return sendJson(res, 404, { error: 'Instance not found.' });
      return sendJson(res, 200, { launchUrl: buildLaunchUrl(instance), instance: presentInstance(instance) });
    }

    if (req.method === 'POST' && url.pathname === '/api/instances') {
      const body = await readBody(req);
      const { name, image, presetName, password, hostPort, internalPort, networkMode, extraEnv, binds, persistentProfile, profileMountPath } = body || {};
      const presets = loadPresets();
      const preset = presetName ? presets.find((item) => item.name === presetName) : null;
      const resolvedImage = image || preset?.image;
      const resolvedInternalPort = internalPort || preset?.internalPort || DEFAULT_INTERNAL_PORT;
      const resolvedNetworkMode = networkMode || preset?.networkMode || DEFAULT_NETWORK_MODE;
      const resolvedProfileMountPath = profileMountPath || preset?.profileMountPath || DEFAULT_PROFILE_MOUNT_PATH;
      const resolvedExtraEnv = [...(preset?.extraEnv || []), ...sanitizeExtraEnv(extraEnv)];
      const resolvedBinds = [...(preset?.binds || []), ...sanitizeStringArray(binds)];

      if (!name || !resolvedImage || !password) {
        return sendJson(res, 400, { error: 'name, image or presetName, and password are required.' });
      }

      if (getInstances().length >= MAX_INSTANCES) {
        return sendJson(res, 409, { error: `Instance limit reached (${MAX_INSTANCES}). Delete an existing desktop to create a new one.` });
      }

      let numericPort;
      if (hostPort) {
        numericPort = Number(hostPort);
        if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
          return sendJson(res, 400, { error: 'hostPort must be a valid TCP port.' });
        }
        const conflict = getInstances().find((item) => Number(item.hostPort) === numericPort);
        if (conflict) return sendJson(res, 409, { error: `Port ${numericPort} is already assigned to "${conflict.name}".` });
        if ((await listUsedHostPorts()).includes(numericPort)) return sendJson(res, 409, { error: `Port ${numericPort} is already in use on the Docker host.` });
      } else {
        numericPort = await findAvailablePort();
      }

      const id = crypto.randomUUID().slice(0, 10);
      const instance = {
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
        createdAt: new Date().toISOString(),
        status: 'creating',
        containerId: null,
        cloudflare: {
          published: false,
          hostname: null,
          service: null,
          dnsRecordId: null,
          routeCreatedAt: null,
          dnsCreatedAt: null,
          lastPublishedAt: null,
          lastError: null,
        },
      };

      instance.status = 'pulling';
      saveInstance(instance);
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
      if (!instance) return sendJson(res, 404, { error: 'Instance not found.' });

      if (req.method === 'POST' && action === 'start') {
        if (!instance.containerId) return sendJson(res, 404, { error: 'Instance not found.' });
        const inspect = await startContainer(instance.containerId);
        const updated = updateInstance(instance.id, (item) => ({ ...item, status: inspect.State?.Status || 'running' }));
        return sendJson(res, 200, { instance: presentInstance(updated, inspect) });
      }

      if (req.method === 'POST' && action === 'stop') {
        if (!instance.containerId) return sendJson(res, 404, { error: 'Instance not found.' });
        const inspect = await stopContainer(instance.containerId);
        const updated = updateInstance(instance.id, (item) => ({ ...item, status: inspect.State?.Status || 'exited' }));
        return sendJson(res, 200, { instance: presentInstance(updated, inspect) });
      }

      if (req.method === 'POST' && action === 'reset') {
        const body = await readBody(req);
        const inspect = await recreateInstance(instance, { clearProfile: Boolean(body?.clearProfile) });
        const updated = updateInstance(instance.id, (item) => ({ ...item, containerId: inspect.Id, status: inspect.State?.Status || 'running', resetAt: new Date().toISOString() }));
        return sendJson(res, 200, { instance: presentInstance(updated, inspect) });
      }

      if (req.method === 'DELETE' && !action) {
        if (instance.cloudflare?.published || instance.cloudflare?.hostname) {
          try {
            const unpublished = await unpublishInstanceCloudflare(instance);
            updateInstance(instance.id, (item) => ({ ...item, cloudflare: unpublished }));
          } catch (error) {
            const failed = updateInstance(instance.id, (item) => ({
              ...item,
              cloudflare: {
                ...(item.cloudflare || {}),
                lastError: error.message,
              },
            }));
            return sendJson(res, 409, {
              error: `Failed to remove Cloudflare route for "${instance.name}": ${error.message}`,
              instance: failed ? presentInstance(failed) : undefined,
            });
          }
        }
        if (instance.containerId) {
          try { await removeContainer(instance.containerId, true); } catch {}
        } else {
          const existingId = await findContainerByInstanceId(instance.id);
          if (existingId) try { await removeContainer(existingId, true); } catch {}
        }
        if (url.searchParams.get('removeProfile') === 'true' && instance.persistentProfile) {
          try { await removeProfileVolume(instance); } catch {}
        }
        removeInstance(instance.id);
        return sendJson(res, 200, { ok: true });
      }
    }

    const publishMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/publish$/);
    if (req.method === 'POST' && publishMatch) {
      const instance = getInstance(publishMatch[1]);
      if (!instance) return sendJson(res, 404, { error: 'Instance not found.' });
      const body = await readBody(req);
      const hostname = body?.hostname ? String(body.hostname) : '';
      const cloudflare = await publishInstanceCloudflare(instance, hostname);
      const updated = updateInstance(instance.id, (item) => ({
        ...item,
        cloudflare,
      }));
      return sendJson(res, 200, { instance: presentInstance(updated) });
    }

    const unpublishMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/unpublish$/);
    if (req.method === 'POST' && unpublishMatch) {
      const instance = getInstance(unpublishMatch[1]);
      if (!instance) return sendJson(res, 404, { error: 'Instance not found.' });
      const cloudflare = await unpublishInstanceCloudflare(instance);
      const updated = updateInstance(instance.id, (item) => ({
        ...item,
        cloudflare,
      }));
      return sendJson(res, 200, { instance: presentInstance(updated) });
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Internal server error' });
  }
}

async function handleLaunch(req, res, url) {
  const match = url.pathname.match(/^\/launch\/([^/]+)$/);
  if (!match) return false;
  if (!isAuthorized(req)) {
    return redirect(res, '/');
  }
  const instance = getInstance(match[1]);
  if (!instance) {
    return sendText(res, 404, 'Instance not found');
  }
  return redirect(res, buildLaunchUrl(instance));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);

  const launchHandled = await handleLaunch(req, res, url);
  if (launchHandled !== false) return;

  if (shouldProxy(url.pathname)) {
    if (!isAuthorized(req)) return redirect(res, '/');
    const target = getProxyTarget(url.pathname);
    if (!target) return sendText(res, 404, 'Managed instance not found for this path.');
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
    if (!shouldProxy(url.pathname)) {
      socket.destroy();
      return;
    }
    if (!isAuthorized(req)) {
      socket.destroy();
      return;
    }
    const target = getProxyTarget(url.pathname);
    if (!target) {
      socket.destroy();
      return;
    }
    proxyWebSocket(req, socket, head, target);
  } catch {
    try { socket.destroy(); } catch {}
  }
});

server.listen(PORT, () => {
  console.log(`Kasm manager listening on port ${PORT}`);
});
