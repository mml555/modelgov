# Disaster recovery runbook

How to back up Modelgov state and restore it after data loss, corruption, or a
regional outage. Modelgov's only durable state lives in **Postgres** — the API,
LiteLLM, and Presidio tiers are stateless and are recovered by redeploying
images. Recovery therefore reduces to **Postgres backup + restore** plus config
(`modelgov.yaml`, secrets) redeploy.

> **Status:** The backup/restore mechanics below are standard Postgres
> operations and are real. The specific **RTO/RPO targets, multi-region posture,
> and drill cadence are recommendations** — Modelgov ships no managed DR service
> (self-host only). Adopt and test them on your infrastructure. Modelgov has no
> built-in automated backup scheduler; you wire that up with managed snapshots or
> cron `pg_dump`.

---

## Targets (recommended)

| Objective | Target | Notes |
| --- | --- | --- |
| **RPO** (max data loss) | **≤ 5 min** with managed PITR; **≤ 24 h** with daily `pg_dump` | Point-in-time recovery (WAL/continuous archiving) gives the tighter RPO |
| **RTO** (time to restore) | **≤ 1 h** single-region; **≤ 4 h** cross-region | Dominated by DB restore time + DNS/`DATABASE_URL` cutover |
| **Stateless-tier recovery** | Minutes | Redeploy pinned API/LiteLLM/Presidio images |

RPO/RTO are business decisions. The single most important control is that
**Postgres has automated, tested backups** — this is already a line item in the
[production checklist](../operations.md#production-checklist).

---

## What to back up

| Table | Contents | Criticality | If lost |
| --- | --- | --- | --- |
| `budget_counters` | Live spend/reservation state (used + reserved per dimension) | **High** | Budget windows reset; risk of over-spend until counters rebuild from the current window |
| `request_logs` | Audit trail (metadata only — no prompts/completions) | **High** (compliance) | Loss of audit/usage history; cost attribution gaps |
| `api_keys` | DB-issued key hashes + scoping | **High** | All DB-issued keys stop working (only bootstrap `MODELGOV_API_KEYS` static keys survive); every consumer must be re-keyed |
| `idempotency_keys` | Short-lived in-flight/replay records | **Low** | Recent retries may re-execute; auto-swept anyway (`IDEMPOTENCY_STALE_MS`, default 15m) |

Back up the **whole database** (all four tables plus schema/migration state), not
individual tables — partial restores risk schema/migration drift. Also protect,
outside the DB:

- **`modelgov.yaml`** — policy source of truth (version-control it).
- **Secrets** — `DATABASE_URL`, `MODELGOV_API_KEYS` bootstrap key,
  `LITELLM_MASTER_KEY`, provider keys, `BUDGET_ALERT_WEBHOOK_SECRET`,
  `DATABASE_SSL_CA`. Store in a secrets manager; back that up per its own policy.

> **Not in Postgres:** prompts and completions are **not** stored in
> `request_logs` (metadata only). If you enabled Langfuse content capture
> (`OBSERVABILITY_CAPTURE_CONTENT=true`, off by default) or idempotency content
> capture (`IDEMPOTENCY_CAPTURE_CONTENT=true`, off by default), those stores hold
> sensitive content and need their own backup + retention treatment. Defaults
> keep content out of durable storage — see [data-flow](../compliance/data-flow.md).

---

## Automated backup procedure

### Option A — managed Postgres (recommended)

Use the provider's automated backups + point-in-time recovery:

- **RDS/Aurora:** enable automated backups (retention ≥ 7 days), enable PITR.
  Optionally copy snapshots to a second region.
- **Cloud SQL:** enable automated backups + PITR (binary logging / WAL).
- Verify the backup **retention window** covers your longest acceptable
  detection-to-restore gap.

### Option B — `pg_dump` on a schedule (self-managed Postgres)

```bash
# Nightly logical backup (cron). Uses custom format for parallel restore.
pg_dump "$DATABASE_URL" \
  --format=custom \
  --file="/backups/modelgov-$(date -u +%Y%m%dT%H%M%SZ).dump"

# Retain 30 days, prune older
find /backups -name 'modelgov-*.dump' -mtime +30 -delete
```

- Ship dumps to off-host, versioned object storage (S3/GCS) with a lifecycle
  policy and, ideally, **object-lock/immutability** so ransomware can't delete
  them.
- For tighter RPO than nightly, add **continuous WAL archiving** (`archive_command`
  → object storage) to enable PITR.
- Encrypt backups at rest (SSE) and in transit.

### Backup validation (do not skip)

A backup you have never restored is a guess. Automate a **restore-and-verify**
check (see drill below) at least monthly against a throwaway DB.

---

## Step-by-step tested-restore drill

Run this end to end on a schedule (see cadence). Time each phase to validate RTO.

```bash
# 0. Announce the drill; if in prod, put the API in maintenance / drain traffic.
#    (LB stops routing when /ready fails; you can also scale API replicas to 0.)

# 1. Provision a fresh, empty Postgres (throwaway for drills; the DR target for real).
export RESTORE_DB_URL="postgres://user:pass@restore-host:5432/modelgov"

# 2a. Restore from pg_dump (Option B):
pg_restore --clean --if-exists --no-owner \
  --dbname="$RESTORE_DB_URL" \
  /backups/modelgov-<timestamp>.dump

# 2b. OR restore a managed snapshot / PITR to a new instance (Option A) via the
#     cloud console/CLI, choosing the target timestamp (closest before the incident).

# 3. Apply any migrations newer than the backup (idempotent; advisory-locked):
docker run --rm -e DATABASE_URL="$RESTORE_DB_URL" --env-file .env.production \
  your-registry/modelgov-api:<pinned-tag> node dist/migrate.js

# 4. Point the API at the restored DB and start it.
#    DATABASE_URL="$RESTORE_DB_URL" ... (compose/k8s secret cutover)

# 5. Verify readiness and correctness:
curl -sf "$MODELGOV_URL/ready" | jq .          # expect ready:true, db ok

# 6. Spot-check restored state (needs a usage:read / requests:read key):
curl -s "$MODELGOV_URL/v1/usage?userId=<known_user>" \
  -H "Authorization: Bearer $OPS_KEY" | jq .    # budget_counters intact
curl -s "$MODELGOV_URL/v1/requests?since=7d&limit=5" \
  -H "Authorization: Bearer $OPS_KEY" | jq .    # request_logs intact

# 7. Verify a DB-issued API key still authenticates (api_keys restored):
curl -s "$MODELGOV_URL/v1/explain" \
  -H "Authorization: Bearer $A_DB_ISSUED_KEY" -H 'content-type: application/json' \
  -d '{"userId":"drill","userType":"logged_in","feature":"support_chat","modelClass":"cheap"}' \
  | jq .decision

# 8. Smoke test a guarded call end-to-end (POST /v1/chat) if a provider is reachable.

# 9. Record: backup timestamp used, restore duration (RTO), data gap (RPO),
#    and any anomalies. Tear down the throwaway DB.
```

**Post-restore reconciliation notes:**

- **Budget counters** reflect the backup moment. Any spend between the backup and
  the incident is not counted — for a hard financial guarantee, prefer PITR to
  the incident edge. After restore, orphaned `reserved_usd` (from the crash) is
  released by the maintenance sweep after `RESERVATION_STALE_MS` (default 15m).
- **Idempotency keys** older than `IDEMPOTENCY_STALE_MS` are swept; recent retries
  may re-run — acceptable given the low criticality.
- If `api_keys` could not be restored, immediately re-issue keys via the bootstrap
  `keys:admin` static key and rotate consumers.

---

## Multi-region strategy

Modelgov has **no built-in cross-region replication**; achieve it at the data and
deploy layers:

| Layer | Multi-region approach |
| --- | --- |
| **Postgres** | Cross-region read replica or managed global DB (Aurora Global, Cloud SQL cross-region replica). Promote the standby on regional loss; repoint `DATABASE_URL`. Alternatively, cross-region snapshot copies for warm-standby restore. |
| **API / LiteLLM / Presidio** | Stateless — pre-deploy (or IaC-templated) in the secondary region, scaled to zero or minimal until failover. |
| **Config & secrets** | Replicate `modelgov.yaml` (Git) and secrets (multi-region secrets manager) to both regions. |
| **Traffic** | DNS/global LB failover to the secondary region's LB. |
| **Redis** | Regional; the secondary region has its own. Rate-limit state is not business-critical to preserve across regions (spend guard is Postgres). |

**Trade-off to document per deployment:** a single global counter row (global
monthly budget) does not exist independently per region. If you run
**active-active** across regions with separate databases, global budget is
enforced *per region*, not globally — accept this, or run **active-passive**
(one writable Postgres, secondary promoted only on failover) to keep global
budget authoritative. Active-passive is the recommended default.

**Failover sketch:** promote standby Postgres → update `DATABASE_URL` secret in
secondary region → scale up secondary API tier → run `migrate.js` (no-op if
current) → verify `/ready` → cut DNS. Then follow the reconciliation notes above.

---

## Periodic-drill checklist

Run and record every quarter (minimum); after any schema migration; and after any
change to the backup pipeline.

- [ ] Confirm automated backups ran and the latest is within the retention window.
- [ ] Confirm backups are off-host, encrypted, and (ideally) immutable/object-locked.
- [ ] Restore the latest backup to a **throwaway** database (never overwrite prod).
- [ ] Run migrations against the restore; confirm they are a no-op or apply cleanly.
- [ ] Start the API against the restore; confirm `GET /ready` returns ready.
- [ ] Verify `budget_counters`, `request_logs`, and `api_keys` are present and
      queryable (`/v1/usage`, `/v1/requests`, DB-issued key auth).
- [ ] Measure and record **actual RTO** (restore start → `/ready` green) and
      **RPO** (backup timestamp → intended recovery point). Compare to targets.
- [ ] Exercise the **secrets restore** path (can you recover `DATABASE_URL`,
      bootstrap key, provider keys from the secrets manager?).
- [ ] Once per year: full **cross-region failover** drill (promote standby, cut
      DNS, serve traffic from the secondary region).
- [ ] File the drill report; open follow-ups for any target miss.

Related: [operations backups](../operations.md#backups),
[high-availability](../deployment/high-availability.md),
[incident response](./incident-response.md).
