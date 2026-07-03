# SOC 2 evidence collection — operator runbook

[`soc2-controls.md`](./soc2-controls.md) maps Modelgov's **technical** controls to
the Trust Services Criteria. A Type II audit additionally requires **evidence that
the controls operated over a period**. This runbook turns the "operator action"
column of that mapping into a concrete cadence, with the commands and artifacts to
retain. It covers the controls Modelgov can produce evidence for; the purely
organizational controls (HR, training, vendor management — CC1–CC5, CC9) are out of
scope here and belong in your GRC tooling.

> **Framing:** SOC 2 certifies *your organization's* controls over the system, not
> the Modelgov software. This runbook produces the operator-side evidence; a
> licensed CPA firm performs the examination.

## Evidence cadence at a glance

| Evidence | Source | Cadence | Retain |
| --- | --- | --- | --- |
| Admin audit trail (key/policy/erasure mutations) | `admin_audit_log` → WORM/SIEM export | Continuous (nightly ship) | Full audit period |
| Audit-chain integrity check | `audit:export` verify / `GET /v1/admin/audit/verify` | Daily (automated) | Check results, audit period |
| Access review (API keys + operator roles) | `GET /v1/admin/keys`, OIDC role map | Quarterly | Sign-offs, audit period |
| Vulnerability scan + SBOM | CI (`docker.yml`: Trivy + SBOM/provenance) | Every build | Reports per release |
| Backup + restore drill | Postgres snapshots + [DR runbook](../runbooks/disaster-recovery.md) | Quarterly | Drill reports |
| Incident response drill | [Incident runbook](../runbooks/incident-response.md) | Semi-annual | Drill reports, real incidents |
| Metrics/alerting retention | `/metrics` → Prometheus, budget-alert webhook | Continuous | Alert + response records |
| Change-management records | PRs, deploy logs, `config_versions` (policy store) | Per change | Audit period |

## Audit trail: export to WORM / SIEM + verify

CC7.2 expects the privileged-mutation audit trail to be shipped to an append-only
(WORM) or SIEM sink and its integrity checked on a cadence. The `admin_audit_log`
is a hash chain (`0009_admin_audit_log.sql`); tampering with, inserting, or
deleting any historical row breaks every subsequent hash.

**Export as JSON Lines (and verify the chain):**

```bash
# Full export to a file. Exit code is non-zero (2) if the chain is broken, so
# this doubles as the daily integrity check. Use --out (not shell redirection)
# so the file is never mixed with the package-runner banner.
DATABASE_URL=postgres://... \
  pnpm -s --filter @modelgov/api audit:export -- --out /var/log/modelgov/audit-$(date +%F).jsonl

# Incremental nightly ship (only rows after the last exported id). Chain
# verification always covers the whole chain regardless of --since-id.
DATABASE_URL=postgres://... \
  pnpm -s --filter @modelgov/api audit:export -- --since-id "$LAST_ID" | your-siem-forwarder
```

Point the output at your WORM sink (S3 Object Lock, GCS retention policy, or a
SIEM's ingest agent — Splunk HEC, Datadog, an OTel log pipeline). A non-zero exit
code means **tamper detected** — alert on it.

**Online verification** (no DB creds needed, uses the API) is also available for a
lightweight scheduled check:

```bash
curl -sf -H "authorization: Bearer $ADMIN_KEY" https://<host>/v1/admin/audit/verify
# → {"ok":true,"rows":N}  (ok:false + brokenAtId if the chain was altered)
```

**Automate it** — e.g. a nightly systemd timer / k8s CronJob that runs the export
to your WORM bucket and pages if the exit code is non-zero. Retain both the JSONL
artifacts and the verification results for the full audit period.

## Access reviews (CC6.2 / CC6.3)

Quarterly, review and sign off on:

- **API keys** — `GET /v1/admin/keys` (or `modelgov keys list`). Confirm each
  active key's `permissions`, `projectId`/`tenantId` scope, and `expiresAt` are
  still appropriate; revoke unused keys (`modelgov keys revoke`). Every
  create/rotate/revoke is already in the audit trail above.
- **Operator roles** — the OIDC `OIDC_ROLE_MAP` and who holds
  `owner`/`policy-admin`/`key-admin`. Confirm least privilege.

Retain the reviewed list + reviewer sign-off.

## Change management (CC8.1)

- **Code/image changes** — PR reviews + deploy logs are your SDLC evidence; images
  carry provenance + SBOM attestations (see `docker.yml`).
- **Policy changes** — with `POLICY_STORE_ENABLED`, every policy version is stored,
  validated, and activated as an audited operation (`config_versions` +
  `policy.activate` in the audit trail); rollback = activating a prior version.
  This is your change record for enforcement policy itself.

## Availability evidence (A1.x)

- **Backups + restore** — run the [DR drill](../runbooks/disaster-recovery.md)
  quarterly; retain the drill report (RTO/RPO achieved). Modelgov ships no backup
  scheduler — evidence comes from your managed Postgres snapshots/PITR.
- **Health/redundancy** — `/health` + `/ready` probe configs and HPA/replica
  settings (Helm values) document the redundancy posture; the
  [HA reference](../deployment/high-availability.md) is the design of record.

## Confidentiality & privacy evidence (C1.x / P)

- **Retention** — `REQUEST_LOG_RETENTION_MS` and per-feature `retention_days` are
  your data-disposal control; the maintenance sweep enforces them (see
  [operations](../operations.md#data-retention)).
- **Erasure (DSAR)** — `POST /v1/admin/erasure` deletes a user's request-linked
  data and is itself audited; retain erasure records as DSAR evidence.
- **Content minimization** — `OBSERVABILITY_CAPTURE_CONTENT` and
  `IDEMPOTENCY_CAPTURE_CONTENT` default off; screenshot/export the settings as
  evidence that prompt content is not persisted by default.

## Encryption evidence (CC6.6 / CC6.7 / C1.1)

Modelgov has **no built-in TLS** — TLS is terminated at your LB and enforced to
Postgres via `DATABASE_SSL=verify-full`. Retain the LB/TLS config and the
`DATABASE_SSL` setting as your in-transit-encryption evidence; at-rest encryption
evidence comes from your Postgres/backup/secrets-manager configuration.

---

Related: [SOC 2 control mapping](./soc2-controls.md),
[threat model](./threat-model.md), [security questionnaire](../commercial/security-questionnaire.md),
[disaster recovery](../runbooks/disaster-recovery.md).
