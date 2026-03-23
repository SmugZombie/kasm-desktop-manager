# Kasm Desktop Manager Starter v4

This version adds a built-in path proxy and launch workflow so managed desktops can be opened through `/<port>/` and launched through `/launch/<instanceId>`.

## What changed in v4

- built-in reverse proxy for managed Kasm ports
- managed path routing like `/6901/`
- launch button in the UI
- `/launch/:id` helper that redirects to a best-effort auto-connect URL
- WebSocket proxy support for Kasm/noVNC traffic
- response rewriting for:
  - `Location` headers
  - cookie `Path`
  - common root-relative asset and websocket references in HTML/JS/CSS
- still zero npm dependencies

## Important reality check

The `/<port>/` proxy mode is a **best-effort compatibility layer** for images that normally expect to live at `/`. It is useful when tools like Cloudflare Tunnel are publishing a subpath instead of a dedicated hostname.

For many Kasm/noVNC images, this works well enough to get through auth and into the desktop. But some images may still have frontend assumptions that are hardcoded to root paths. If that happens, a dedicated hostname per instance is still the most reliable option.

The direct launch flow uses a noVNC-style URL with `autoconnect=1`, `password=...`, and `path=<port>/websockify`. This is convenient, but it also means the password appears in the generated launch URL for that session. Use this only behind trusted access controls.

## Quick start

```bash
cp .env.example .env
# edit ADMIN_TOKEN
docker compose up -d --build
```

Open:

- `http://YOUR-HOST:3000`

## New launch behavior

Each instance now has:

- a proxied route: `/<hostPort>/`
- a launch route: `/launch/<instanceId>`
- an API launch value: `GET /api/instances/:id/launch`

Example:

- `http://manager-host:3000/6901/`
- `http://manager-host:3000/launch/abc123def4`

The manager redirects `/<port>/` to a launch URL like:

```text
/<port>/vnc.html?autoconnect=1&password=YOURPASSWORD&path=<port>/websockify&resize=remote&reconnect=1
```

## Reverse proxy / Cloudflare Tunnel idea

Point the tunnel at the manager app, not directly at the Kasm desktop:

- `https://kasm.example.com/6901/` -> manager container -> desktop on local port 6901
- `https://kasm.example.com/6902/` -> manager container -> desktop on local port 6902

That lets the manager handle the path stripping and best-effort rewriting.

## Environment variables

```env
ADMIN_TOKEN=change-this-now
ENABLE_REVERSE_PROXY_AUTH=false
REVERSE_PROXY_USER_HEADER=x-forwarded-user
REVERSE_PROXY_REQUIRED_VALUE=
PASSWORD_ENV_KEY=VNC_PW
DEFAULT_INTERNAL_PORT=6901/tcp
DEFAULT_NETWORK_MODE=bridge
DEFAULT_PROFILE_MOUNT_PATH=/home/kasm-user
INSTANCE_NAME_PREFIX=kasm-desktop-
PROFILE_VOLUME_PREFIX=kasm-profile-
MANAGED_LABEL=com.egli.kasm-manager.managed
PROXY_TEXT_REWRITE=true
LAUNCH_AUTOCONNECT=true
LAUNCH_RESIZE=remote
LAUNCH_VIEW_ONLY=false
```

## API

- `GET /api/health`
- `GET /api/config`
- `GET /api/presets`
- `GET /api/ports`
- `GET /api/instances`
- `GET /api/instances/:id/launch`
- `POST /api/instances`
- `POST /api/instances/:id/start`
- `POST /api/instances/:id/stop`
- `POST /api/instances/:id/reset`
- `DELETE /api/instances/:id`

## Security notes

This manager:
- mounts the Docker socket
- stores instance passwords in its local instance registry
- can place launch passwords in the browser URL for auto-connect

Put it behind trusted auth. Cloudflare Access or another auth gateway is strongly recommended.
