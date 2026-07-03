# Routing & the allow / block / degrade / fallback decision

How Modelgov picks a model and what each policy outcome means. Routing is
intentionally boring in v0.5 — deterministic and easy to reason about.

## Model classes

Each entry in `model_classes` has a **primary** and optional **fallback**:

```yaml
model_classes:
  cheap:    { primary: openai/gpt-4o-mini,   fallback: anthropic/claude-haiku }
  standard: { primary: anthropic/claude-sonnet, fallback: openai/gpt-4o }
  premium:  { primary: openai/gpt-5,         fallback: anthropic/claude-opus }
```

- **primary** — used on `allow` and `degrade`.
- **fallback** — used only on `fallback` (primary provider failed).

## Class tiers (degrade order)

Classes are ordered **cheapest → most expensive**. Budget-aware degrade only
ever moves *down* this order, to the next class the user type is permitted to
use. The default order is `cheap → standard → premium`; override it with
`routing.class_order` to define your own tiers:

```yaml
routing:
  class_order: [nano, cheap, standard, premium]
```

Every entry must be a defined `model_class`; classes not in the list are
un-degradable (degrade won't pick them).

## The four outcomes

| Decision | Meaning | Model used |
| --- | --- | --- |
| **allow** | Within all caps and permitted | class **primary** |
| **degrade** | Global spend ≥ `routing.degrade_at_percent` and a cheaper permitted class exists | cheaper class **primary** |
| **fallback** | Primary provider call failed (5xx/429/network) | effective class **fallback** |
| **block** | A hard rule was violated — request refused | none |

## Block vs. degrade — the key distinction

**Degrade keeps serving; block refuses.**

- **Degrade** happens *proactively* when the global monthly budget crosses the
  degrade threshold: the request still runs, just on a cheaper permitted model.
  If no cheaper permitted class exists, the request proceeds on the requested
  class (there is nothing to degrade to).
- **Block** happens when a hard limit or rule is hit:

| Block reason (`reasonCode`) | Trigger |
| --- | --- |
| `model_class_not_permitted` | User type isn't allowed that class |
| `daily_request_limit_reached` | User daily request count exhausted |
| `daily_budget_exceeded` | User daily USD cap would be exceeded |
| `feature_monthly_budget_exceeded` | Feature monthly cap would be exceeded |
| `global_monthly_budget_exceeded` | Global monthly hard stop reached |
| `data_sensitivity_not_permitted` | Resolved model/provider not approved for the feature's data class |

A blocked request returns `403` with the `reasonCode` and `budgetRemaining`; a
degraded/fallback request returns `200` with `decision` set accordingly so the
caller can see what happened.

## Fallback details

- Fallback triggers only on a **provider-side failure** of the primary (5xx,
  429, timeout, network) — never on a 4xx client error.
- The reservation is **topped up** to the fallback model's estimate before the
  fallback call, so caps aren't marginally overshot on that path.
- There is **no mid-stream fallback** for `stream: true` requests (once bytes
  flow, the primary is committed).

## Ordering of gates (per request)

1. Model-class permitted for the user type? → else `block`.
2. Budget-aware degrade check (may switch to a cheaper class).
3. Data-sensitivity gate on the resolved class/provider → else `block`.
4. Budget gates (request count, user daily, feature monthly, global hard stop)
   → else `block`.
5. `allow` (or `degrade` if step 2 downgraded).

See [Architecture](./ARCHITECTURE.md) for the engine internals,
[configuration](./configuration.md) for the knobs, and
[failure semantics](./failure-semantics.md) for the error contract.
