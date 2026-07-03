# Management console — design & status

A web UI over the control-plane APIs so FinOps, security, and platform teams can
operate Modelgov without editing YAML or using the CLI.

> **Status:** design. The **backend the console needs is already built and
> tested** (see below) — this is a frontend that consumes existing endpoints. No
> new server capability is required for a read-heavy v1.

## The APIs already exist

Every surface the console needs is a shipped, authenticated endpoint:

| Console view | Backing API | Permission |
| --- | --- | --- |
| Spend dashboard (by feature/user/type, cost) | `GET /v1/usage`, `GET /v1/usage/summary` | `usage:read` |
| Request audit explorer | `GET /v1/requests`, `/v1/requests/:id` | `requests:read` |
| API key management (issue/rotate/revoke) | `/v1/admin/keys*` | `keys:admin` |
| Policy editor + version history + rollback | `/v1/admin/policy/*` | `policy:read` / `policy:write` |
| Admin audit log + chain verify | `/v1/admin/audit`, `/verify` | `audit:read` |
| Data erasure (DSAR) | `POST /v1/admin/erasure` | `data:erase` |

## Auth

The console authenticates operators via **OIDC SSO** (already implemented,
[`authz`]): the browser gets a JWT from the corporate IdP; the console sends it
as `Authorization: Bearer <jwt>` to the same API. **RBAC roles** (viewer /
finops / key-admin / policy-admin / owner) already gate every endpoint, so the
console just reflects the operator's permissions (hide/disable what they can't
do) — enforcement stays server-side.

## Tech

- Static SPA (React/Vite or SvelteKit) served as its own container or from a CDN
  — no coupling to the API process.
- Talks only to the documented HTTP API (typed against `openapi.json`, the same
  spec the SDKs use).
- No secrets in the browser: the JWT is the only credential; API keys created in
  the UI show their plaintext **once** (matching the API contract) and are never
  re-fetchable.

## Surfaces (v1)

1. **Overview** — global spend vs cap, degrade/fallback rates, block reasons
   (from `usage/summary` + Prometheus `/metrics`).
2. **Keys** — table with prefix/name/permissions/last-used; create (one-time
   secret modal), rotate, revoke. Reads never expose hashes.
3. **Policy** — YAML editor with client-side validate → save version → diff →
   activate/rollback; version history from `/v1/admin/policy/versions`.
4. **Audit** — filterable admin action log with a "verify chain" button
   surfacing `/v1/admin/audit/verify`.
5. **Requests** — audit explorer (metadata only; content is never stored).
6. **Privacy** — DSAR erasure form (gated by `data:erase`).

## Build notes / roadmap

- v1 is read-mostly + the mutations above; **live spend charts** can poll
  `usage/summary` or scrape Prometheus.
- **Zero-restart policy apply** depends on the hot-reload item in
  [dynamic-policy](./dynamic-policy.md); until then the console shows "activated
  — applies on next rolling restart".
- **Multi-tenant views** land with [multi-tenancy](./multi-tenancy.md) (tenant
  switcher, per-tenant budgets).
- A static, self-contained **mockup** can be produced as a first deliverable to
  align on layout before wiring the live API.

Because the API contract is fixed and typed, the console is decoupled
frontend work — it can be built and shipped independently of the gateway.
