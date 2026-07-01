# Ai-Guard documentation

Ai-Guard is a **self-hosted AI control plane**. You run it in your infrastructure;
your applications call it to enforce cost, safety, and routing policy before any
model request reaches a provider.

## Start here

| Doc | Who | What |
| --- | --- | --- |
| [Mental model](./mental-model.md) | Everyone | Who owns what — read this first |
| [Integration checklist](./integration-checklist.md) | App developers | Add Ai-Guard in ~20 minutes |
| [Real app pattern](./integrations/real-app-pattern.md) | App developers | Production integration (event intake) |
| [Self-host overview](./self-host.md) | Decision makers, platform teams | What you deploy, licensing, support model |
| [Getting started](./getting-started.md) | Everyone | Install → first API call in under 5 minutes |
| [Configuration](./configuration.md) | Operators | `ai-guard.yaml` reference |
| [TypeScript SDK](./sdk-typescript.md) | App developers | `createAiGuardClient`, types, errors |
| [HTTP API](./api.md) | Any stack | REST, auth, idempotency, OpenAPI |
| [Operations](./operations.md) | DevOps / SRE | Production deploy, health, backups, scaling |
| [Failure semantics](./failure-semantics.md) | SRE / engineers | Dependency failures, error contract |
| [Budget alerts runbook](./runbooks/budget-alerts.md) | On-call | Alert thresholds, inspect spend, raise caps |
| [Expensive queries](./runbooks/expensive-queries.md) | On-call | Find costly users/features |
| [Integration debugging](./runbooks/integration-debugging.md) | On-call | Host app ↔ Ai-Guard correlation |
| [Architecture](./ARCHITECTURE.md) | Engineers | Policy engine, budgets, authorization boundary |

## Enterprise deployment

| Doc | Who | What |
| --- | --- | --- |
| [High-availability architecture](./deployment/high-availability.md) | Platform / SRE | HA reference topology, component-failure matrix, SLO targets |
| [Benchmarking methodology](./deployment/benchmarks.md) | Platform / SRE | How to measure gateway overhead + results template (placeholders) |

## Operations & reliability

| Doc | Who | What |
| --- | --- | --- |
| [Disaster recovery](./runbooks/disaster-recovery.md) | SRE / on-call | RTO/RPO, backups, tested-restore drill, multi-region |
| [Incident response](./runbooks/incident-response.md) | On-call | SEV1–4 classification, escalation, comms + post-mortem templates |
| [Versioning & compatibility](./versioning.md) | Integrators / operators | SemVer for API/SDK/config, support window, 1.0 checklist |

## Security & compliance

| Doc | Who | What |
| --- | --- | --- |
| [Threat model (STRIDE)](./compliance/threat-model.md) | Security | Trust boundaries, threats, mitigations, residual risk |
| [SOC 2 control mapping](./compliance/soc2-controls.md) | Security / GRC | TSC controls, status, gaps, what a Type II audit needs |
| [Data flow & DLP](./compliance/data-flow.md) | Security / privacy | Stored vs transient data, PII handling, retention, leak surfaces |

## Commercial & procurement

| Doc | Who | What |
| --- | --- | --- |
| [Commercial pack overview](./commercial/README.md) | Sales / procurement | How to use the templates below |
| [SLA template](./commercial/sla.md) | Procurement | Uptime %, severity response/resolution, credits |
| [Support tiers](./commercial/support-tiers.md) | Procurement | Community / Business / Enterprise + escalation |
| [Security questionnaire](./commercial/security-questionnaire.md) | Security review | Pre-filled SIG/CAIQ-style answers + DPA/subprocessor outline |

## Design notes (roadmap items)

| Doc | What |
| --- | --- |
| [Dynamic policy store](./design/dynamic-policy.md) | Versioned/validated/audited policy store (built, opt-in) + hot-reload/approval roadmap |
| [Multi-tenancy & hierarchical budgets](./design/multi-tenancy.md) | Nested budgets, atomic multi-level reservation, counter sharding, tenant isolation |
| [Management console](./design/management-console.md) | Web UI over the (already-built) admin APIs; SSO + RBAC |

## Quick links

- Example apps: [`event_intake_app`](../examples/event_intake_app), [`support_chat`](../examples/support_chat), [`saas_tiers`](../examples/saas_tiers), [`document_extraction`](../examples/document_extraction), [`nextjs_support_chat`](../examples/nextjs_support_chat)
- Dev config sample: [`ai-guard.yaml`](../ai-guard.yaml)
- Production policy template: [`ai-guard.production.example.yaml`](../ai-guard.production.example.yaml)
- OpenAPI (when API is running): `GET /openapi.json`
