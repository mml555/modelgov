# Modelgov documentation

Modelgov is a **self-hosted AI control plane**. You run it in your infrastructure;
your applications call it to enforce cost, safety, and routing policy before any
model request reaches a provider.

**Current release:** `v1.0.1` — install pinned artifacts; do not deploy from `main` in production.

---

## Start here

| Doc | Who | What |
| --- | --- | --- |
| [Getting started](./getting-started.md) | Everyone | Install → first API call in under 5 minutes |
| [Mental model](./mental-model.md) | Everyone | Who owns what — read this first |
| [Self-host overview](./self-host.md) | Decision makers | What you deploy, licensing, deploy modes |
| [Production claims](./production-claims.md) | Evaluators / procurement | Guarantees, limitations, unsupported assumptions |

## Integrate into your app

| Doc | Who | What |
| --- | --- | --- |
| [Integration checklist](./integration-checklist.md) | App developers | Add Modelgov in ~20 minutes |
| [Real app pattern](./integrations/real-app-pattern.md) | App developers | Production integration (event intake) |
| [TypeScript SDK](./sdk-typescript.md) | App developers | `createModelgovClient`, types, errors |
| [HTTP API](./api.md) | Any stack | REST, auth, idempotency, OpenAPI |
| [OpenAPI client generation](./openapi-client.md) | Any stack | Generate a typed client from the spec |
| [Configuration](./configuration.md) | Operators | `modelgov.yaml` reference |
| [Providers](./providers.md) | Operators | OpenAI, Anthropic, Gemini, OpenRouter, Azure, Bedrock |
| [Routing & block-vs-degrade](./routing.md) | Operators / engineers | Model selection, outcomes, decision table |

## Run in production

| Doc | Who | What |
| --- | --- | --- |
| [**Production deploy guide**](./production-deploy.md) | Platform / SRE | **Official Helm path** — end-to-end |
| [Operations](./operations.md) | DevOps / SRE | Health, backups, scaling, metrics |
| [High-availability architecture](./deployment/high-availability.md) | Platform / SRE | HA topology, failure matrix |
| [Upgrades](./upgrades.md) | SRE | Supported paths, rollback, migrations |
| [Benchmarks](./deployment/benchmarks.md) | Platform / SRE | Harness + baseline numbers |

## Operate and debug

| Doc | Who | What |
| --- | --- | --- |
| [Operator console](../apps/operator-console/README.md) | Operators | Self-hosted admin UI |
| [Production readiness drill](./runbooks/production-readiness-drill.md) | SRE | Post-deploy smoke script |
| [Backup / restore drill](./runbooks/backup-restore-drill.md) | SRE | Tested restore procedure |
| [Budget alerts runbook](./runbooks/budget-alerts.md) | On-call | Alert thresholds, raise caps |
| [Incident response](./runbooks/incident-response.md) | On-call | SEV classification, escalation |
| [Integration debugging](./runbooks/integration-debugging.md) | On-call | Host app ↔ Modelgov correlation |
| [Failure semantics](./failure-semantics.md) | SRE / engineers | Dependency failures, error contract |

## Security and compliance

| Doc | Who | What |
| --- | --- | --- |
| [Threat model (STRIDE)](./compliance/threat-model.md) | Security | Trust boundaries, mitigations |
| [SOC 2 control mapping](./compliance/soc2-controls.md) | Security / GRC | TSC controls, gaps |
| [Data flow & DLP](./compliance/data-flow.md) | Security / privacy | Stored vs transient data |
| [Enterprise readiness checklist](./enterprise-readiness-checklist.md) | Platform leads | Pre-GA checklist with links |
| [Versioning & compatibility](./versioning.md) | Integrators | SemVer, support window |

## Reference

| Doc | Who | What |
| --- | --- | --- |
| [Architecture](./ARCHITECTURE.md) | Engineers | Policy engine, budgets, auth boundary |
| [How Modelgov compares](./comparison.md) | Evaluators | vs LiteLLM / observability / gateways |
| [Commercial pack](./commercial/README.md) | Procurement | SLA, support tiers, questionnaire |

## Design notes (roadmap)

| Doc | What |
| --- | --- |
| [Dynamic policy store](./design/dynamic-policy.md) | Versioned policy store (built, opt-in) |
| [Multi-tenancy](./design/multi-tenancy.md) | Nested budgets, counter sharding |
| [Management console design](./design/management-console.md) | Console architecture (implemented in `apps/operator-console`) |

## Quick links

- Example apps: [`event_intake_app`](../examples/event_intake_app), [`support_chat`](../examples/support_chat)
- Production policy: [`modelgov.production.example.yaml`](../modelgov.production.example.yaml)
- Production env: [`.env.production.example`](../.env.production.example)
- OpenAPI: `GET /openapi.json` or release asset `openapi-v1.0.1.json`
