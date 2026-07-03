# Budget alerts runbook

When global monthly spend crosses `budgets.global.alert_at_percent`, Modelgov
fires a webhook (if `BUDGET_ALERT_WEBHOOK_URL` is configured) and records the
alert so it is not sent repeatedly for the same window.

## What happens at 80% (default alert)

| Mechanism | Behavior |
| --- | --- |
| **Webhook** | POST to your URL with spend vs threshold |
| **Routing degrade** | At `routing.degrade_at_percent` (often also 80%), permitted requests may **degrade** one model class |
| **Hard stop** | At `hard_stop_at_percent` (default 100%), new requests **block** with `global_monthly_budget_exceeded` |

Degrade and alert thresholds are independent in config but are often aligned at 80%.

## Inspect current spend

```bash
# Budget counters (live)
curl -s "$MODELGOV_URL/v1/usage" -H "Authorization: Bearer $OPS_KEY" | jq .

# Aggregated audit summary (last 24h)
pnpm modelgov usage summary --since 24h
```

Requires API key with `usage:read`.

> The `pnpm modelgov ...` invocations in this runbook are the monorepo form. If
> you installed the CLI as a package, drop the `pnpm` prefix and run `modelgov ...`
> directly.

## Find expensive users and features

```bash
# Recent blocked requests
pnpm modelgov requests list --status blocked --since 24h

# By feature
pnpm modelgov usage summary --feature support_chat --since 7d

# Inspect one request
pnpm modelgov requests show req_123
```

### SQL (direct Postgres access)

```sql
-- Top features by cost (last 7 days)
SELECT feature, count(*) AS requests, sum(actual_cost_usd) AS cost_usd
FROM request_logs
WHERE created_at >= now() - interval '7 days'
GROUP BY 1
ORDER BY cost_usd DESC
LIMIT 20;

-- Top users by cost
SELECT user_id, user_type, count(*) AS requests, sum(actual_cost_usd) AS cost_usd
FROM request_logs
WHERE created_at >= now() - interval '7 days'
GROUP BY 1, 2
ORDER BY cost_usd DESC
LIMIT 20;

-- Top block reasons
SELECT reason_code, count(*)
FROM request_logs
WHERE status <> 'ok' AND created_at >= now() - interval '7 days'
GROUP BY 1
ORDER BY 2 DESC;
```

## Raise a budget

1. Edit `modelgov.yaml`:

   ```yaml
   budgets:
     global:
       monthly_usd: 1500   # was 1000
   ```

2. Reload the API (restart container or redeploy).
3. Budget counters are **not** reset — only the cap changes.

> Live cap changes without a redeploy: when the policy store is enabled
> (`POLICY_STORE_ENABLED=true`), store the edited config as a new version and
> activate it via `POST /v1/admin/policy/versions/:id/activate` (needs
> `policy:write`) — the new caps take effect without restarting the API.

Per-user-type daily caps:

```yaml
budgets:
  by_user_type:
    free_user:
      daily_usd: 0.10     # raise from 0.05
      daily_requests: 30
```

## Temporarily disable a feature

There is no dedicated kill-switch endpoint, but when the policy store is enabled
(`POLICY_STORE_ENABLED=true`) you can apply the changes below at runtime by
activating a new policy version (`POST /v1/admin/policy/versions/:id/activate`)
instead of redeploying. Otherwise, edit `modelgov.yaml` and redeploy. Options:

1. **Remove the feature** from `modelgov.yaml` and redeploy — requests return `400 unknown_feature`.
2. **Set caps to zero** on the user types that use it:

   ```yaml
   by_user_type:
     free_user:
       daily_requests: 0
   ```

3. **Block at the app layer** — stop calling Modelgov for that product path.

Prefer (1) or (3) for emergencies; (2) produces `policy_blocked` errors.

## Verify policy before changes

```bash
pnpm modelgov explain --local \
  --userType free_user --feature support_chat --modelClass standard

pnpm modelgov validate --config modelgov.yaml --production
```

## Related docs

- [Failure semantics](./failure-semantics.md) — what blocks vs degrades vs 503s
- [Operations](../operations.md) — webhooks, retention, backups
- [Configuration](../configuration.md) — budget and alert fields
