# Expensive users and features

Operator queries for finding who is spending AI budget and which product
features drive cost.

## CLI (recommended)

```bash
export MODELGOV_API_KEY=your-ops-key

# Feature cost rollup (24h default)
modelgov usage summary --feature support_chat --since 7d

# All traffic summary
modelgov usage summary --since 24h

# Blocked requests for a user
modelgov requests list --userId user_123 --status blocked --since 7d

# Drill into one request
modelgov requests show req_456
```

## API

```bash
# List requests
curl -s "$MODELGOV_URL/v1/requests?feature=support_chat&since=7d&limit=100" \
  -H "Authorization: Bearer $OPS_KEY" | jq .

# Summary
curl -s "$MODELGOV_URL/v1/usage/summary?since=7d&feature=support_chat" \
  -H "Authorization: Bearer $OPS_KEY" | jq .

# Single request
curl -s "$MODELGOV_URL/v1/requests/req_456" \
  -H "Authorization: Bearer $OPS_KEY" | jq .
```

Permissions: `requests:read` for `/v1/requests`, `usage:read` for `/v1/usage/summary`.

## Postgres queries

Run against your Modelgov database when you need ad-hoc analysis.

```sql
-- Most expensive features (30 days)
SELECT
  feature,
  count(*) FILTER (WHERE status = 'ok') AS completed,
  count(*) FILTER (WHERE status <> 'ok') AS blocked,
  round(sum(coalesce(actual_cost_usd, 0))::numeric, 4) AS actual_usd
FROM request_logs
WHERE created_at >= now() - interval '30 days'
GROUP BY feature
ORDER BY actual_usd DESC;

-- Most expensive users
SELECT
  user_id,
  user_type,
  count(*) AS requests,
  round(sum(coalesce(actual_cost_usd, 0))::numeric, 4) AS actual_usd
FROM request_logs
WHERE created_at >= now() - interval '30 days'
  AND user_id IS NOT NULL
GROUP BY user_id, user_type
ORDER BY actual_usd DESC
LIMIT 50;

-- Fallback rate by model
SELECT
  resolved_model,
  count(*) FILTER (WHERE decision = 'fallback') AS fallbacks,
  count(*) AS total
FROM request_logs
WHERE created_at >= now() - interval '7 days'
GROUP BY 1
ORDER BY fallbacks DESC;
```

## Privacy note

`request_logs` stores **metadata only** — no prompt or completion text. Message
content lives in optional observability backends (Langfuse) when enabled.

Reading prompt content requires `observability.capture_content: true` and
Langfuse access — not exposed via `/v1/requests` in v0.4.

Future permission `requests:read_content` is reserved for explicit content
replay paths (e.g. idempotency body when enabled).

## Related

- [Budget alerts runbook](./budget-alerts.md)
- [Failure semantics](../failure-semantics.md)
