# Commercial & procurement pack

Templates for teams offering Ai-Guard as a supported product or internal platform,
and pre-filled answers for enterprise procurement/security review.

> **Status — read first.** Ai-Guard is **open-source, self-hosted software (MIT)**.
> There is **no hosted SaaS and no vendor-operated SLA today** (self-host only, per
> [self-host overview](../self-host.md) and [operations known limitations](../operations.md#known-limitations-v1)).
> The SLA and support-tier documents here are **templates** for whoever operates
> Ai-Guard — a commercial provider, or your own platform team running it internally
> for downstream teams. They are **not** commitments from the Ai-Guard project.
> The security questionnaire answers describe the **software's real architecture**
> and are safe to use in vendor reviews, but organizational answers (who staffs
> on-call, where you host) must be filled in by the operating entity.

## Contents

| Doc | Purpose | Fill-in needed |
| --- | --- | --- |
| [SLA template](./sla.md) | Uptime %, severity response/resolution times, service credits | Operating entity, targets, credit schedule |
| [Support tiers](./support-tiers.md) | Community / Business / Enterprise scope + escalation | Contact channels, hours, staffing |
| [Security questionnaire](./security-questionnaire.md) | Pre-filled SIG/CAIQ-style answers grounded in the architecture; DPA/subprocessor outline | Org controls (hosting, on-call, HR), legal entity for the DPA |

## How to use

1. Pick the operating model — commercial vendor vs internal platform.
2. In each template, replace **`[BRACKETED]`** placeholders with real values.
3. Cross-reference the technical facts (which are real) against the source docs
   linked throughout: [architecture](../ARCHITECTURE.md),
   [operations](../operations.md), [threat model](../compliance/threat-model.md),
   [SOC 2 mapping](../compliance/soc2-controls.md), [data-flow](../compliance/data-flow.md).
4. Do **not** present the SLA/support tiers as project guarantees — they bind only
   the entity that signs them.
