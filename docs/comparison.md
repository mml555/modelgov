# How Ai-Guard compares

Ai-Guard is a **self-hosted AI policy gateway**: policy is checked *before* the
model call, every request declares a `user`, `userType`, and `feature`, and cost
**and tokens** are reserved up front. It's plug-in infrastructure (like Clerk for
auth) — it does not replace your app's auth/RBAC.

| Need | Ai-Guard | LiteLLM alone | Observability tools (Helicone/Langfuse) | Cloud gateways |
| --- | --- | --- | --- | --- |
| Multi-provider routing | ✅ (via LiteLLM under it) | ✅ | ❌ | partial |
| **Pre-call policy** (block before spend) | ✅ | ❌ (proxy/routing) | ❌ (after the fact) | partial |
| Per-user / per-feature **budgets** | ✅ | key-level only | ❌ | partial |
| **Token limits** (not just cost) | ✅ | ❌ | ❌ | rare |
| Safety (PII mask/block, injection) | ✅ (Presidio) | ❌ | ❌ | varies |
| Budget-aware **degrade** + fallback | ✅ | fallback only | ❌ | partial |
| Data-sensitivity model/provider gating | ✅ | ❌ | ❌ | ❌ |
| Per-request audit + decision reason | ✅ | limited | ✅ (traces) | varies |
| Self-hosted (data stays in your infra) | ✅ | ✅ | self-host option | ❌ (SaaS) |

## When Ai-Guard is the right fit

- You want a single choke point so **no app calls providers directly**.
- You need to **stop** runaway spend/usage, not just observe it after.
- You care about per-user/feature limits on **both cost and tokens**.
- You want safety + routing + audit in one boring, self-hosted layer.

## When it isn't (yet)

- You only need a hosted dashboard for traces → an observability tool is lighter.
- You only need provider failover with no policy → LiteLLM alone suffices.
- You want a fully managed SaaS with zero ops → Ai-Guard is self-host only today.

## How it relates to LiteLLM

Ai-Guard sits **in front of** LiteLLM: LiteLLM owns provider credentials and
execution; Ai-Guard owns policy (budgets, tokens, safety, routing decisions,
audit). You keep LiteLLM's provider breadth and add enforcement + visibility.
