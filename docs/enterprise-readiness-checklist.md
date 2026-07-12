# Enterprise readiness checklist

Use this checklist before calling a deployment **enterprise-ready**. Every item links to evidence — no vague "future work" in the enterprise section.

## Release

- [x] [Version surfaces consistent](../scripts/verify-versions.sh) — `bash scripts/verify-versions.sh`
- [x] [Release artifacts published](../.github/workflows/release.yml) — tag `v*` triggers npm, PyPI, OpenAPI asset
- [x] [Release verification script](../scripts/verify-release-artifacts.sh) — `scripts/verify-release-artifacts.sh v1.7.1`
- [x] [Changelog complete](../CHANGELOG.md)
- [x] [Migration notes included](../docs/upgrades.md)

## Security

- [x] [Production boot checks enabled](../packages/api/src/config/productionGuards.ts) — `MODELGOV_PRODUCTION=true`
- [x] [Default secrets rejected](../packages/api/test/productionGuards.test.ts)
- [x] [Metrics protected](../docs/production-deploy.md#required-environment-variables)
- [x] [TLS/proxy documented](../docs/production-deploy.md#tls-and-load-balancer)
- [x] [API key rotation tested](../docs/runbooks/production-readiness-drill.md)
- [x] [Tenant scoping tested](../packages/api/test/) — integration tests + [multi-tenancy design](./design/multi-tenancy.md)

## Operations

- [x] [Production deploy guide tested](./production-deploy.md)
- [x] [Readiness/liveness configured](./production-deploy.md#readiness-and-liveness)
- [x] [Backup/restore drill tested](./runbooks/backup-restore-drill.md)
- [x] [Upgrade drill tested](./upgrades.md)
- [x] [Incident runbook exists](./runbooks/incident-response.md)
- [x] [Budget alert runbook exists](./runbooks/budget-alerts.md)

## Reliability

- [x] [HA reference path documented](./deployment/high-availability.md)
- [x] [Failure semantics tested](./failure-semantics.md)
- [x] [Redis failure behavior documented](./failure-semantics.md)
- [x] [Postgres outage behavior documented](./failure-semantics.md)
- [x] [LiteLLM/Presidio failure behavior documented](./failure-semantics.md)

## Observability

- [x] [Logs structured](../docs/operations.md)
- [x] [Metrics exposed/protected](../docs/operations.md#metrics)
- [x] [Tracing optional](../docs/configuration.md)
- [x] [Content capture default safe](../docs/production-claims.md)
- [x] [Request correlation documented](./runbooks/integration-debugging.md)

## Performance

- [x] [Benchmark harness exists](../scripts/bench-api-latency.ts) + [reservation bench](../scripts/bench-node-reservation.ts)
- [x] [Baseline results published](./deployment/benchmarks.md#baseline-measurement)
- [x] [Known bottlenecks documented](./deployment/benchmarks.md#hierarchical-budget-reservation--counter-sharding)
- [x] [Counter sharding guidance documented](./design/multi-tenancy.md)

## Operator tooling

- [x] [Operator console](../apps/operator-console/) — self-hosted admin UI
- [x] [Production doctor](../packages/cli/src/doctorProduction.ts) — `pnpm modelgov doctor production`
- [x] [Production readiness script](../scripts/prod-readiness-check.sh)

## Definition of done

When all sections above are checked, Modelgov meets the [production claims](./production-claims.md) for a self-hosted enterprise deployment.
