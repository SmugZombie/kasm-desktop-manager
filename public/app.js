// Elements
const loginOverlay   = document.getElementById('loginOverlay');
const githubLoginBtn = document.getElementById('githubLoginBtn');
const loginMessage   = document.getElementById('loginMessage');
const appEl          = document.getElementById('app');
const logoutBtn      = document.getElementById('logoutBtn');
const currentUserEl  = document.getElementById('currentUser');
const newDesktopBtn  = document.getElementById('newDesktopBtn');
const createPanel    = document.getElementById('createPanel');
const closePanelBtn  = document.getElementById('closePanelBtn');
const createForm     = document.getElementById('createForm');
const createMessage  = document.getElementById('createMessage');
let appConfig = {};

const vncPassword        = document.getElementById('vncPassword');
const togglePassword     = document.getElementById('togglePassword');
const regenPassword      = document.getElementById('regenPassword');
const presetSelect       = document.getElementById('presetName');
const imageSelect        = document.getElementById('imageSelect');
const tagSelect          = document.getElementById('tagSelect');
const tagField           = document.getElementById('tagField');
const customImageField   = document.getElementById('customImageField');
const customImageInput   = document.getElementById('customImageInput');
const refreshBtn     = document.getElementById('refreshBtn');
const instancesEl    = document.getElementById('instances');
const messageEl      = document.getElementById('message');

// ── Alerts ────────────────────────────────────────────────
function showAlert(el, text, type = 'error') {
  el.textContent = text;
  el.className = `alert ${type}`;
  el.classList.remove('hidden');
}

function hideAlert(el) {
  el.classList.add('hidden');
}

// ── API ───────────────────────────────────────────────────
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) { showLogin(); throw new Error('Session expired — please sign in again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function parseLines(text, mode = 'string') {
  return String(text || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    if (mode === 'env') {
      const idx = l.indexOf('=');
      return idx === -1 ? null : { key: l.slice(0, idx).trim(), value: l.slice(idx + 1).trim() };
    }
    return l;
  }).filter(Boolean);
}

// ── Auth ──────────────────────────────────────────────────
function showLogin() {
  loginOverlay.classList.remove('hidden');
  appEl.classList.add('hidden');
}

function hideLogin() {
  loginOverlay.classList.add('hidden');
  appEl.classList.remove('hidden');
}

function showLoginError() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get('auth_error');
  if (!error) return;
  showAlert(loginMessage, error);
  // Drop the query string so a refresh does not keep replaying the error
  window.history.replaceState({}, '', window.location.pathname);
}

async function showCurrentUser() {
  try {
    const { user } = await api('/api/me');
    if (!user) { currentUserEl.classList.add('hidden'); return; }
    currentUserEl.textContent = `@${user.login}`;
    currentUserEl.title = user.email ? `${user.name} · ${user.email}` : user.name;
    currentUserEl.classList.remove('hidden');
  } catch {
    currentUserEl.classList.add('hidden');
  }
}

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  showLogin();
});

// ── Password helpers ──────────────────────────────────────
function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#%';
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

togglePassword.addEventListener('click', () => {
  const show = vncPassword.type === 'password';
  vncPassword.type = show ? 'text' : 'password';
  togglePassword.textContent = show ? '🙈' : '👁';
});

regenPassword.addEventListener('click', () => {
  vncPassword.value = generatePassword();
  vncPassword.type = 'text';
  togglePassword.textContent = '🙈';
});

// ── Create panel ──────────────────────────────────────────
newDesktopBtn.addEventListener('click', () => {
  createPanel.classList.toggle('hidden');
  if (!createPanel.classList.contains('hidden')) {
    vncPassword.value = generatePassword();
    vncPassword.type = 'text';
    togglePassword.textContent = '🙈';
    createForm.querySelector('input[name="name"]').focus();
  }
});

closePanelBtn.addEventListener('click', () => createPanel.classList.add('hidden'));

createForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAlert(createMessage);
  const form = new FormData(createForm);
  let image;
  if (imageSelect.value === '__custom__') {
    image = customImageInput.value.trim() || undefined;
  } else if (imageSelect.value) {
    const tag = tagSelect.value || 'latest';
    image = `kasmweb/${imageSelect.value}:${tag}`;
  }

  const payload = {
    presetName: presetSelect.value || undefined,
    name: form.get('name'),
    image,
    password: form.get('password'),
    hostPort: form.get('hostPort') ? Number(form.get('hostPort')) : undefined,
    internalPort: form.get('internalPort') || undefined,
    networkMode: form.get('networkMode') || undefined,
    extraEnv: parseLines(form.get('extraEnv'), 'env'),
    binds: parseLines(form.get('binds'), 'string'),
    persistentProfile: form.get('persistentProfile') === 'on',
    profileMountPath: form.get('profileMountPath') || undefined,
  };
  try {
    await api('/api/instances', { method: 'POST', body: JSON.stringify(payload) });
    createForm.reset();
    createPanel.classList.add('hidden');
    showAlert(messageEl, `Desktop "${payload.name}" created.`, 'success');
    await loadInstances();
  } catch (err) {
    showAlert(createMessage, err.message);
  }
});

// ── Instances ─────────────────────────────────────────────
const TRANSIENT_STATES = new Set(['pulling', 'creating']);
let pollTimer = null;

function stateClass(state = '') {
  const s = state.toLowerCase();
  if (s === 'running') return 'running';
  if (s === 'exited' || s === 'stopped') return 'exited';
  if (s === 'paused') return 'paused';
  if (s === 'pulling' || s === 'creating') return s;
  if (s === 'error') return 'error';
  return '';
}

function stateLabel(state = '') {
  if (state === 'pulling') return '⬇ pulling image…';
  if (state === 'creating') return '⚙ starting…';
  return state;
}

function startPollingIfNeeded(instances) {
  const hasTransient = instances.some(i => TRANSIENT_STATES.has(i.state || i.status));
  if (hasTransient && !pollTimer) {
    pollTimer = setInterval(async () => {
      try {
        const data = await api('/api/instances');
        renderInstances(data.instances || []);
        if (!data.instances.some(i => TRANSIENT_STATES.has(i.state || i.status))) {
          clearInterval(pollTimer);
          pollTimer = null;
          loadLocalImages();
        }
      } catch { clearInterval(pollTimer); pollTimer = null; }
    }, 3000);
  } else if (!hasTransient && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function instanceCard(inst) {
  const isPending = TRANSIENT_STATES.has(inst.state);
  const isError = inst.state === 'error';
  const card = document.createElement('div');
  card.className = `instance-card${isPending ? ' is-pending' : ''}${isError ? ' is-error' : ''}`;

  const actionsHtml = isPending ? '' : `
    <button class="btn btn-primary btn-sm" data-action="launch">Launch</button>
    <button class="btn btn-outline btn-sm" data-action="open-route">Open /${inst.hostPort}/</button>
    <button class="btn btn-outline btn-sm" data-action="start">Start</button>
    <button class="btn btn-outline btn-sm" data-action="stop">Stop</button>
    <button class="btn btn-outline btn-sm" data-action="reset">Reset</button>
    <button class="btn btn-danger btn-sm" data-action="delete">Delete</button>
  `;

  card.innerHTML = `
    <div class="instance-top">
      <span class="status-dot ${stateClass(inst.state)}"></span>
      <span class="instance-name">${inst.name}</span>
      <span class="instance-state">${stateLabel(inst.state)}</span>
      <div class="instance-actions">${actionsHtml}</div>
    </div>
    ${isError && inst.error ? `<div class="instance-error">Error: ${inst.error}</div>` : ''}
    <div class="instance-meta">
      <span class="meta-tag">${inst.image}</span>
      <span class="meta-sep">·</span>
      <span class="meta-tag">Port <strong>${inst.hostPort}</strong></span>
      ${!isPending ? `
      <span class="meta-sep">·</span>
      <span class="meta-tag">Proxy <a href="${inst.pathPrefix}/" target="_blank" rel="noopener">${inst.pathPrefix}/</a></span>
      ` : ''}
      ${inst.persistentProfile ? `<span class="meta-sep">·</span><span class="meta-tag">📁 Profile</span>` : ''}
      ${inst.containerId ? `<span class="meta-sep">·</span><span class="meta-tag" style="font-family:monospace;font-size:11px">${inst.containerId.slice(0,12)}</span>` : ''}
    </div>
  `;

  card.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      hideAlert(messageEl);
      try {
        if (action === 'launch') { window.open(`/launch/${inst.id}`, '_blank', 'noopener'); return; }
        if (action === 'open-route') { window.open(`${inst.pathPrefix}/`, '_blank', 'noopener'); return; }
        if (action === 'start')  await api(`/api/instances/${inst.id}/start`, { method: 'POST' });
        if (action === 'stop')   await api(`/api/instances/${inst.id}/stop`, { method: 'POST' });
        if (action === 'reset')  await api(`/api/instances/${inst.id}/reset`, { method: 'POST', body: JSON.stringify({ clearProfile: false }) });
        if (action === 'delete') {
          if (!confirm(`Delete "${inst.name}"?`)) return;
          await api(`/api/instances/${inst.id}`, { method: 'DELETE' });
        }
        showAlert(messageEl, `${action.charAt(0).toUpperCase() + action.slice(1)} completed for "${inst.name}".`, 'success');
        await loadInstances();
      } catch (err) {
        showAlert(messageEl, err.message);
      }
    });
  });

  return card;
}

function renderInstances(instances) {
  instancesEl.innerHTML = '';
  if (!instances.length) {
    instancesEl.innerHTML = '<p class="empty-state">No desktops yet — create one above.</p>';
  } else {
    instances.forEach(inst => instancesEl.appendChild(instanceCard(inst)));
  }
  updateInstanceCountBadge(instances.length, appConfig.maxInstances ?? 10);
  startPollingIfNeeded(instances);
}

async function loadInstances() {
  const data = await api('/api/instances');
  renderInstances(data.instances || []);
}

function updateInstanceCountBadge(count, max) {
  const badge = document.getElementById('instanceCountBadge');
  badge.textContent = `${count} / ${max}`;
  badge.classList.remove('hidden', 'at-limit');
  if (count >= max) badge.classList.add('at-limit');
}

async function loadPresets() {
  const data = await api('/api/presets');
  presetSelect.innerHTML = '<option value="">— no preset —</option>';
  for (const p of data.presets || []) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = `${p.name} (${p.image})`;
    presetSelect.appendChild(opt);
  }
}

async function loadKasmImages() {
  try {
    const data = await api('/api/kasm-images');
    imageSelect.innerHTML = '<option value="">Select a kasmweb image…</option>';
    for (const img of data.images || []) {
      const opt = document.createElement('option');
      opt.value = img.name;
      opt.textContent = img.name;
      imageSelect.appendChild(opt);
    }
  } catch {
    imageSelect.innerHTML = '';
  }
  const custom = document.createElement('option');
  custom.value = '__custom__';
  custom.textContent = 'Custom image…';
  imageSelect.appendChild(custom);
}

imageSelect.addEventListener('change', async () => {
  const val = imageSelect.value;
  if (val === '__custom__') {
    tagField.classList.add('hidden');
    customImageField.classList.remove('hidden');
    customImageInput.focus();
    return;
  }
  customImageField.classList.add('hidden');
  if (!val) { tagField.classList.add('hidden'); return; }

  tagField.classList.remove('hidden');
  tagSelect.innerHTML = '<option value="">Loading…</option>';
  try {
    const data = await api(`/api/kasm-images/${val}/tags`);
    tagSelect.innerHTML = '';
    for (const tag of data.tags || []) {
      const opt = document.createElement('option');
      opt.value = tag;
      opt.textContent = tag;
      tagSelect.appendChild(opt);
    }
    if (!tagSelect.options.length) tagSelect.innerHTML = '<option value="">No tags found</option>';
  } catch {
    tagSelect.innerHTML = '<option value="">Failed to load tags</option>';
  }
});

refreshBtn.addEventListener('click', async () => {
  hideAlert(messageEl);
  try { await loadInstances(); } catch (err) { showAlert(messageEl, err.message); }
});

// ── Stats ─────────────────────────────────────────────────
function fmt(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
  return (bytes / 1e3).toFixed(0) + ' KB';
}

function setFill(id, pct) {
  const el = document.getElementById(id);
  el.style.width = pct + '%';
  el.className = 'stat-fill' + (pct >= 90 ? ' crit' : pct >= 70 ? ' warn' : '');
}

let statsTimer = null;

async function loadStats() {
  try {
    const s = await api('/api/stats');
    const cpuPct  = s.cpu;
    const ramPct  = s.memTotal  ? Math.round(s.memUsed  / s.memTotal  * 100) : 0;
    const diskPct = s.diskTotal ? Math.round(s.diskUsed / s.diskTotal * 100) : 0;

    setFill('cpuFill',  cpuPct);
    setFill('ramFill',  ramPct);
    setFill('diskFill', diskPct);

    document.getElementById('cpuVal').textContent  = `${cpuPct}%`;
    document.getElementById('ramVal').textContent  = `${fmt(s.memUsed)} / ${fmt(s.memTotal)} (${ramPct}%)`;
    document.getElementById('diskVal').textContent = `${fmt(s.diskUsed)} / ${fmt(s.diskTotal)} (${diskPct}%)`;
    document.getElementById('statsAge').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch {
    document.getElementById('statsAge').textContent = 'unavailable';
  }
}

function startStatsPolling() {
  loadStats();
  if (!statsTimer) statsTimer = setInterval(loadStats, 8000);
}

// ── Local images ──────────────────────────────────────────
const deleteAllImagesBtn = document.getElementById('deleteAllImagesBtn');

deleteAllImagesBtn.addEventListener('click', async () => {
  if (!confirm('Delete all local kasmweb images? Running containers using these images will not be affected.')) return;
  deleteAllImagesBtn.disabled = true;
  deleteAllImagesBtn.textContent = 'Deleting…';
  try {
    const data = await api('/api/local-images', { method: 'DELETE' });
    if (data.errors?.length) showAlert(messageEl, `Removed ${data.removed} image(s). Errors: ${data.errors.join(', ')}`, 'error');
    else showAlert(messageEl, `Removed ${data.removed} image(s).`, 'success');
  } catch (err) {
    showAlert(messageEl, err.message);
  } finally {
    deleteAllImagesBtn.disabled = false;
    deleteAllImagesBtn.textContent = 'Delete All';
    await loadLocalImages();
  }
});

async function loadLocalImages() {
  const el = document.getElementById('localImagesList');
  const countEl = document.getElementById('localImagesCount');
  try {
    const data = await api('/api/local-images');
    const images = data.images || [];
    countEl.textContent = images.length ? `${images.length} image${images.length === 1 ? '' : 's'} on disk` : '';
    deleteAllImagesBtn.classList.toggle('hidden', images.length === 0);

    if (!images.length) {
      el.innerHTML = '<span class="stats-age">No kasmweb images found locally.</span>';
      return;
    }

    el.innerHTML = '';
    for (const img of images) {
      const ref = `${img.repository}:${img.tag}`;
      const chip = document.createElement('div');
      chip.className = 'local-image-chip';
      chip.innerHTML = `
        <span class="chip-name">${ref}</span>
        <span class="chip-meta">${img.size}</span>
        <button class="chip-delete" title="Delete image" data-ref="${ref}">✕</button>
      `;
      chip.querySelector('.chip-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete image ${ref}?`)) return;
        const btn = e.currentTarget;
        btn.textContent = '…';
        btn.disabled = true;
        try {
          await api(`/api/local-images/${encodeURIComponent(ref)}`, { method: 'DELETE' });
          showAlert(messageEl, `Deleted ${ref}.`, 'success');
          await loadLocalImages();
        } catch (err) {
          showAlert(messageEl, err.message);
          btn.textContent = '✕';
          btn.disabled = false;
        }
      });
      chip.addEventListener('click', () => prefillFromLocalImage(img));
      el.appendChild(chip);
    }
  } catch {
    el.innerHTML = '<span class="stats-age">Could not load local images.</span>';
  }
}

function prefillFromLocalImage(img) {
  // Open the panel
  createPanel.classList.remove('hidden');

  // Set the image picker to "Custom" and fill the custom input
  imageSelect.value = '__custom__';
  imageSelect.dispatchEvent(new Event('change'));
  customImageInput.value = `${img.repository}:${img.tag}`;

  // Generate a fresh password if field is empty
  if (!vncPassword.value) {
    vncPassword.value = generatePassword();
    vncPassword.type = 'text';
    togglePassword.textContent = '🙈';
  }

  createForm.querySelector('input[name="name"]').focus();
  createPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Boot ──────────────────────────────────────────────────
async function loadAll() {
  try {
    const cfg = await api('/api/config');
    appConfig = cfg;

    // Update port range hint in the form
    if (cfg.portRangeStart && cfg.portRangeEnd) {
      document.getElementById('portRangeHint').textContent = `auto (${cfg.portRangeStart}–${cfg.portRangeEnd})`;
      document.getElementById('hostPortInput').placeholder = `auto (${cfg.portRangeStart}–${cfg.portRangeEnd})`;
    }

    updateInstanceCountBadge(cfg.instanceCount ?? 0, cfg.maxInstances ?? 10);

    await Promise.all([loadPresets(), loadKasmImages(), loadInstances(), loadLocalImages()]);
    startStatsPolling();
  } catch (err) {
    if (!loginOverlay.classList.contains('hidden')) return;
    showAlert(messageEl, err.message);
  }
}

(async function init() {
  showLoginError();
  try {
    const config = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
    if (config.loginUrl) githubLoginBtn.href = config.loginUrl;
    if (config.authEnabled) {
      let authenticated = false;
      try {
        const probe = await fetch('/api/instances');
        authenticated = probe.ok;
      } catch { /* network error — treat as unauthenticated */ }
      if (!authenticated) { showLogin(); return; }
      showCurrentUser();
    }
    hideLogin();
    await loadAll();
  } catch {
    // Last-resort fallback — always show something rather than a blank page
    showLogin();
  }
})();
