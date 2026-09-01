# Kasm Desktop Manager

Zero-dependency Node manager for Kasm Desktop containers, with GitHub sign-in, a
built-in proxy and a launch workflow.

## What it does

- creates, starts, stops, resets and deletes Kasm desktop containers
- signs users in with GitHub and admits only accounts you list
- serves each desktop either on its own hostname or through `/<port>/`
- proxies HTTP and WebSocket traffic, including noVNC/websockify
- shows host stats, per-container stats and container logs
- keeps an audit trail of who did what
- still ships with no npm dependencies

## Two ways to serve desktops

**Hostname mode (recommended).** Set `DESKTOP_HOSTNAME_TEMPLATE` and each desktop
answers on its own hostname:

```env
DESKTOP_HOSTNAME_TEMPLATE=desktop-{port}.example.com
SESSION_COOKIE_DOMAIN=.example.com
```

Point a wildcard DNS record at the manager. Nothing about the response is
rewritten, and every desktop lands on its own browser origin, so a compromised
desktop image cannot reach the manager's API or the pages of other desktops.

**Path mode (default).** Desktops are served under `/<hostPort>/` on the
manager's own hostname. This is a best-effort compatibility layer: the manager
rewrites `Location` headers, cookie paths and root-relative references in
HTML/CSS/JS so images that expect to live at `/` mostly work. Useful behind a
Cloudflare Tunnel publishing a single hostname, but some images have hardcoded
root paths that no rewriting can fix — and because every desktop shares the
manager's origin, treat the desktops as trusted code.

## Quick start

```bash
cp .env.example .env
# create a GitHub OAuth App, then fill in GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
# and list who may sign in via GITHUB_ALLOWED_USERS / GITHUB_ALLOWED_EMAILS
docker compose up -d --build
```

Open:

- `http://YOUR-HOST:3000`

## Launching a desktop

Each desktop has:

- a direct route — `https://desktop-6901.example.com/` in hostname mode, or
  `/<hostPort>/` in path mode
- a launch route: `/launch/<instanceId>`, which redirects to a noVNC URL with
  `autoconnect=1` and the connection details filled in
- `POST /api/instances/:id/launch`, which mints a one-time launch token and
  returns `/launch/<id>?t=<token>`

The Launch button uses the token route, so a copied URL stops working shortly
after it is used. Anyone who reloads the tab still gets in on their session.

By default the launch URL carries the desktop password, which means it lands in
that tab's address bar. Set `LAUNCH_INCLUDE_PASSWORD=false` to leave it out; the
password is then read on demand from the manager, and the audit log records it.

## Reverse proxy / Cloudflare Tunnel

**Hostname mode** — give the tunnel a wildcard and let each desktop have a host:

- `https://kasm.example.com` -> the manager
- `https://desktop-6901.example.com` -> desktop on local port 6901

Set `SESSION_COOKIE_DOMAIN=.example.com` so the session reaches both.

**Path mode** — point the tunnel at the manager only, and it handles the path
stripping and rewriting:

- `https://kasm.example.com/6901/` -> manager -> desktop on local port 6901

If TLS terminates at the proxy and `X-Forwarded-Proto` is not passed through,
set `FORCE_SECURE_COOKIES=true` so session cookies keep the `Secure` flag.

## Environment variables

`.env.example` is the annotated reference; every variable there is forwarded by
`docker-compose.yml`. The ones worth knowing about:

| Variable | Purpose |
| --- | --- |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | OAuth app credentials. Without them the manager runs unauthenticated. |
| `GITHUB_ALLOWED_USERS` / `GITHUB_ALLOWED_EMAILS` | Who may sign in. |
| `GITHUB_ALLOWED_ORG` / `GITHUB_ALLOWED_TEAM` | Admit a whole GitHub org or team instead of listing people. |
| `GITHUB_ADMIN_USERS` | Who may see every desktop and delete images. Empty = everyone. |
| `SESSION_SECRET` | Signs session cookies. Unset means a restart signs everyone out. |
| `DESKTOP_HOSTNAME_TEMPLATE` | Serve each desktop on its own hostname instead of `/<port>/`. |
| `ALLOW_CUSTOM_BINDS` / `ALLOWED_BIND_PREFIXES` | Bind mounts are refused unless you opt in. |
| `DEFAULT_CPU_LIMIT` / `DEFAULT_MEMORY_LIMIT` / `DEFAULT_SHM_SIZE` / `DEFAULT_PIDS_LIMIT` | Per-desktop resource ceilings. |
| `IDLE_TIMEOUT_MINUTES` | Stop desktops with no traffic for this long. `0` disables it. |
| `LAUNCH_INCLUDE_PASSWORD` | Set `false` to keep the desktop password out of the launch URL. |

## API

Everything under `/api` requires a session; mutating calls must also come from
the manager's own origin.

- `GET /auth/github/login` · `GET /auth/github/callback`
- `GET /api/me` · `POST /api/logout`
- `GET /api/health` · `GET /api/config` · `GET /api/stats`
- `GET /api/presets` · `GET /api/ports`
- `GET /api/instances`
- `POST /api/instances`
- `POST /api/instances/:id/launch` — mints a one-time launch token
- `GET /api/instances/:id/logs?tail=200`
- `GET /api/instances/:id/stats`
- `GET /api/instances/:id/password` — audited
- `POST /api/instances/:id/start` · `stop` · `reset`
- `DELETE /api/instances/:id`
- `GET /api/audit` — admins only
- `GET|DELETE /api/local-images` — deletion is admin-only

## Authentication

Sign-in goes through **GitHub OAuth**. There is no local username/password login.

### 1. Create a GitHub OAuth App

<https://github.com/settings/developers> -> **New OAuth App**

- **Homepage URL**: the manager's public URL, e.g. `https://kasm.example.com`
- **Authorization callback URL**: that URL plus `/auth/github/callback`, e.g. `https://kasm.example.com/auth/github/callback`

Copy the Client ID, generate a Client Secret, and put both in `.env`.

### 2. Say who is allowed in

Authenticating with GitHub is not enough — the account must also be permitted,
by name or by org membership:

```env
GITHUB_ALLOWED_USERS=octocat,my-teammate
GITHUB_ALLOWED_EMAILS=you@example.com
GITHUB_ALLOWED_ORG=my-org
GITHUB_ALLOWED_TEAM=desktops
```

- All list variables accept comma- or whitespace-separated values and are case-insensitive.
- `GITHUB_ALLOWED_USERS` matches the GitHub login. Any entry containing `@` is treated as an email instead, so one variable can hold both kinds.
- `GITHUB_ALLOWED_EMAILS` matches the account's **verified** GitHub emails. An unverified address never grants access.
- `GITHUB_ALLOWED_ORG` admits any active member of that org; add `GITHUB_ALLOWED_TEAM` to narrow it to one team. This requests the `read:org` scope, and a pending invitation does not count as membership.

If every one of these is empty, nobody can sign in and the app warns at startup.

### 3. Decide who is an admin

```env
GITHUB_ADMIN_USERS=you
```

Admins see and control every desktop, may delete images, and can read the audit
log. Everyone else sees only the desktops they created — someone else's desktop
answers `404`, whether through the API, the proxy or a launch URL.

Leaving `GITHUB_ADMIN_USERS` empty makes every permitted user an admin, which
keeps a single-operator setup working exactly as before.

### How it works

- `GET /auth/github/login` redirects to GitHub with a random `state` held in a short-lived `HttpOnly` cookie.
- `GET /auth/github/callback` verifies `state` with a timing-safe compare, exchanges the code for a token, reads the profile plus verified emails, checks the allow list and org, then issues the session cookie.
- Sessions are **signed cookies** (HMAC-SHA256 over the identity and an expiry), so a restart no longer signs everyone out — as long as `SESSION_SECRET` is set. Logout revokes the token server-side until it would have expired anyway.
- The API, both proxy modes, the WebSocket upgrade and `/launch/<id>` all require a valid session.
- `ENABLE_REVERSE_PROXY_AUTH=true` lets an upstream gateway authorize instead, but only when `REVERSE_PROXY_REQUIRED_VALUE` or `REVERSE_PROXY_SHARED_SECRET` is set — an unauthenticated header would otherwise be forgeable by anyone who can reach the port.

If `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` are unset and reverse-proxy auth is off, the manager runs with **no authentication** and warns on startup. Do not expose it in that state.

## Security notes

This manager mounts the Docker socket, so anyone who can create a desktop can
run a container on your host. The controls that matter:

- **Bind mounts are refused by default.** `ALLOW_CUSTOM_BINDS=false` and an empty
  `ALLOWED_BIND_PREFIXES` mean a request cannot mount host paths into a desktop.
  Set `ALLOWED_BIND_PREFIXES=/srv/desktops` to permit a specific subtree.
- **Network modes are restricted** to `bridge,none` by default; `host` and
  `container:` are refused.
- **Desktop passwords never appear in API responses.** They are revealed only by
  `GET /api/instances/:id/password`, which is audited. Set
  `LAUNCH_INCLUDE_PASSWORD=false` to keep them out of launch URLs too, at the
  cost of typing the password into the noVNC prompt.
- **The manager's session cookie is stripped** from every request forwarded to a
  desktop container, so a malicious image cannot read it off the wire.
- **Mutating API calls are origin-checked**, so a desktop page cannot drive the
  API with the viewer's session.
- **Non-admins see only their own desktops.** Set `GITHUB_ADMIN_USERS` to make
  that distinction real; leaving it empty makes everyone an admin.
- **Every mutating action is written to `data/audit.log`** with the GitHub login
  that performed it, readable by admins at `GET /api/audit`.

Still recommended: run it behind TLS, and put Cloudflare Access or another
gateway in front if you want a second layer.

## Development

```bash
npm test        # node:test, no dependencies, no Docker required
npm start
```

The test suite stubs GitHub and the upstream desktop, and covers the OAuth flow,
the allow list, session signing, cookie stripping, proxy response framing,
ownership and the container policy checks.
