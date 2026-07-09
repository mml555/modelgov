# Modelgov Operator Console

Thin self-hosted admin UI over existing Modelgov APIs. No separate database.

## Disable entirely

Do not deploy this app — the API works without it. There is no required console component in the data plane.

## Run locally

```bash
pnpm install
pnpm --filter @modelgov/operator-console dev
```

Set the API URL (defaults to `http://127.0.0.1:3090` when using `./setup`):

```bash
VITE_MODELGOV_URL=http://127.0.0.1:3090 pnpm --filter @modelgov/operator-console dev
```

### First-run setup wizard (`/setup`)

When the stack is started via `./setup`, the autoconnect login link redirects new
sessions to **`/setup`** until setup is marked complete.

- **Quick start for beginners** — demo AI + support chat template (no provider keys).
- **Customize** — all templates, 14+ providers (OpenAI, Anthropic, Gemini, Azure,
  AWS Bedrock, Vertex, Groq, Mistral, OpenRouter, GitHub Copilot, …), credential
  help text, spend caps, and safety presets.

Provider logos and plain-language copy are shown in the wizard; cloud keys are written
via `POST /v1/setup/secrets` to the mounted project `.env` (dev compose only).

Re-run: `localStorage.removeItem('modelgov-setup-v1-complete')` in the browser, then
reload `/setup`.

## Production build

```bash
pnpm --filter @modelgov/operator-console build
# Serve apps/operator-console/dist/ from nginx or a static CDN — internal network only
```

Or build the turnkey container (non-root nginx, SPA fallback, listens on 8080):

```bash
docker build -t modelgov-operator-console apps/operator-console
docker run -p 8080:8080 modelgov-operator-console
```

The API base URL is entered on the login screen and persisted for the session,
so a single build/image serves any deployment — no rebuild per environment. The
`VITE_MODELGOV_URL` build-time value is only the pre-filled default.

## Auth

- **API key:** sign in with a key that has `usage:read`, `requests:read`, and optionally `keys:admin` / `policy:read`.
- **OIDC:** paste a corporate IdP JWT (same as CLI/API operator SSO).

## Screens

| Route | API | Permission |
| --- | --- | --- |
| `/overview` | `GET /v1/usage/summary` + `GET /v1/usage` (live dashboard, polls every 15s) | `usage:read` |
| `/requests` | `GET /v1/requests` | `requests:read` |
| `/usage` | `GET /v1/usage/summary` | `usage:read` |
| `/keys` | `/v1/admin/keys*` | `keys:admin` |
| `/policy` | `/v1/admin/policy/*` (validate, diff, save, approve/reject, activate/rollback, version history) | `policy:read` |
| `/audit` | `GET /v1/admin/audit` + `/verify` (hash-chain integrity) | `audit:read` |
| `/privacy` | `POST /v1/admin/erasure` (DSAR / GDPR erasure) | `data:erase` |
| `/setup` | Guided first-run wizard (policy + optional provider keys) | autoconnect / `usage:read` |
| `/metrics` | Prometheus `/metrics` (own `METRICS_AUTH_TOKEN`, not RBAC) | none |
| `/health` | `/health`, `/ready` | none |

A **tenant switcher** in the header re-scopes every page for platform (unbound)
operators; tenant-bound keys are locked to their own tenant. Nav items are
permission-aware via `GET /v1/admin/whoami`.

## Privacy

- Request logs show **metadata only** (no prompt/message content).
- API key secrets are shown **once** at creation and never stored in the browser beyond the session token.

## Tenant scoping

Tenant-bound keys only see tenant-scoped usage and requests. Owner/admin keys see global data.
