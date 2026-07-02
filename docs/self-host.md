# Self-hosting Ai-Guard

Ai-Guard is designed as an **open, self-hosted product**: you run the control
plane in your own cloud or on-prem environment. There is no requirement to use a
vendor-hosted SaaS — your data, API keys, and policy stay on your infrastructure.

## What you deploy

```text
┌─────────────────────────────────────────────────────────┐
│  Your VPC / datacenter                                  │
│                                                         │
│  ┌──────────────┐    ┌─────────┐    ┌──────────────┐   │
│  │ Ai-Guard API │───▶│ LiteLLM │───▶│ OpenAI / etc │   │
│  │ + Postgres   │    └─────────┘    └──────────────┘   │
│  └──────┬───────┘                                       │
│         │ optional: Presidio (PII), Langfuse (traces)   │
└─────────┼───────────────────────────────────────────────┘
          │
    Your apps (SDK or HTTP)
```

| Component | Required? | Role |
| --- | --- | --- |
| **Ai-Guard API** | Yes | Policy, budgets, safety orchestration |
| **Postgres** | Yes | Usage counters, audit logs, idempotency |
| **LiteLLM** | Yes | Provider routing and execution |
| **Presidio** | Recommended | PII mask/block when safety is enabled |
| **Langfuse** | Optional | Trace UI and cost dashboards (`make up-full`) |

## Deployment modes

| Mode | Command | Intended use |
| --- | --- | --- |
| **Development** | `make up` | Local / dev — API + LiteLLM + Postgres + Presidio |
| **Full observability** | `make up-full` | Local / dev with Langfuse |
| **Local models** | `make up-local` | Local Ollama evaluation |
| **Small production** | `make up-prod` | Self-hosted production on one host (**not HA**) |
| **Enterprise production** | [Helm](./production-deploy.md) | **Recommended** — managed Postgres + Redis + TLS + pinned images |

> **Official production path:** [Production deploy guide](./production-deploy.md) (Helm + managed Postgres + managed Redis + external TLS + pinned images).

## Licensing

Ai-Guard is released under the [MIT License](../LICENSE). You may use, modify,
and distribute it in your organization or product, subject to the license terms.

Upstream components (LiteLLM, Presidio, Langfuse, Postgres) have their own
licenses — review their terms when you ship.

## Support model

Self-hosters are responsible for:

- Infrastructure (compute, DB, TLS, backups)
- Provider API keys and spend with OpenAI/Anthropic/etc.
- Upgrades and security patches

Report security issues per [SECURITY.md](../SECURITY.md).

## Multi-tenant note

v1 assumes a **single policy file** (`ai-guard.yaml`) per deployment. Multiple
apps can share one Ai-Guard instance using different API keys and `feature` names.
Hard multi-tenant isolation (separate configs per customer) requires separate
deployments or future tenancy features.

## Next steps

1. [Getting started](./getting-started.md) — run locally
2. [Production deploy guide](./production-deploy.md) — **official production path**
3. [Configuration](./configuration.md) — define budgets and features
4. [Operations](./operations.md) — production checklist
