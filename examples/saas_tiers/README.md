# SaaS tier example

Demonstrates **free vs paid AI access** with per-tier budgets and model classes.

## Policy highlights

| User type | Daily budget | Requests/day | Models allowed |
| --- | --- | --- | --- |
| `anonymous` | $0.01 | 3 | cheap |
| `free_user` | $0.05 | 20 | cheap |
| `paid_user` | $0.50 | 100 | cheap, standard |
| `admin` | $5.00 | 500 | cheap, standard, premium |

## Try it offline (no stack required)

```bash
pnpm build
pnpm ai-guard explain --local \
  --config examples/saas_tiers/ai-guard.yaml \
  --userType free_user --feature support_chat --modelClass standard
```

Expected: **block** — free users cannot use `standard`.

```bash
pnpm ai-guard explain --local \
  --config examples/saas_tiers/ai-guard.yaml \
  --userType paid_user --feature support_chat --modelClass standard
```

Expected: **allow**.

## Run against the live API

1. Point the stack at this policy file:

   ```bash
   export AI_GUARD_CONFIG=examples/saas_tiers/ai-guard.yaml
   make setup
   ```

2. Demo each tier:

   ```bash
   AI_GUARD_API_KEY=sk-ai-guard-api-local DEMO_USER_TYPE=free_user \
     pnpm --filter saas-tiers-example start "Summarize my account"

   AI_GUARD_API_KEY=sk-ai-guard-api-local DEMO_USER_TYPE=paid_user \
     pnpm --filter saas-tiers-example start "Summarize my account"
   ```

3. Or use explain with live budget data:

   ```bash
   AI_GUARD_API_KEY=sk-ai-guard-api-local pnpm ai-guard explain \
     --userType paid_user --feature support_chat --modelClass premium
   ```
