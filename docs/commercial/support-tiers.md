# Support tiers (template)

> **Template only.** Modelgov is open-source, self-hosted software. "Community"
> reflects the reality of the open-source project (best-effort, no guarantees);
> "Business" and "Enterprise" describe paid tiers an **operating provider** could
> offer. Replace **`[BRACKETED]`** values. Nothing here binds the Modelgov project.

## Tier comparison

| | **Community** | **Business** | **Enterprise** |
| --- | --- | --- | --- |
| **Price** | Free (MIT) | `[$ / mo]` | `[Custom]` |
| **Channels** | GitHub issues / discussions | `[Email + ticket portal]` | `[+ Slack/Teams shared channel, named contact]` |
| **Support hours** | None (community) | `[Business hours, Mon–Fri, region]` | `[24×7 for SEV1; business hours otherwise]` |
| **SLA** | None | [SLA](./sla.md) @ `[99.5%]` | [SLA](./sla.md) @ `[99.9%]` |
| **SEV1 response** | Best-effort | `[1 h]` | `[15 min]` |
| **Named TAM / CSM** | — | — | `[Yes]` |
| **Onboarding / deployment review** | Docs only | `[Guided setup]` | `[Architecture + HA review]` |
| **Security questionnaire / DPA** | Self-serve ([questionnaire](./security-questionnaire.md)) | Supported | `[Custom DPA, security calls]` |
| **Upgrade assistance** | Docs / release notes | `[Guidance]` | `[Hands-on upgrade + migration support]` |
| **Private vulnerability disclosure** | Yes (per [SECURITY.md](../../SECURITY.md)) | Yes | Yes + `[coordinated advisory windows]` |
| **Roadmap input** | Public issues | `[Prioritized requests]` | `[Roadmap influence, design partnership]` |

*Security vulnerability reporting is available to **everyone** regardless of tier
via the process in [SECURITY.md](../../SECURITY.md) — do not gate security behind a
paid tier.*

---

## Escalation flow

```text
Customer report (with requestId / x-modelgov-request-id)
        │
        ▼
 [SUPPORT CHANNEL / PORTAL]  ── triage & severity assignment (SEV1–4)
        │
        ├── SEV3 / SEV4 ─► Support engineer ─► resolve or route to eng backlog
        │
        └── SEV1 / SEV2 ─► On-call engineer (page)  ── follows
                                  │                    [incident-response runbook]
                                  ▼
                         Incident commander (SEV1)
                                  │
                                  ├─► status-page + customer comms updates
                                  └─► post-mortem (SEV1/SEV2)
```

- **Severity** is assigned per the [incident-response runbook](../runbooks/incident-response.md)
  and drives the response/resolution targets in the [SLA](./sla.md).
- **Escalation triggers:** SEV1/SEV2, a missed response target, or explicit
  customer escalation request → page on-call and (SEV1) assign an incident
  commander.
- **Enterprise** customers may escalate directly via `[NAMED CONTACT / SHARED
  CHANNEL]`, bypassing first-line triage for SEV1.

---

## What to include in a support request

To hit response targets, include:

- Approximate timestamps (UTC) and affected `feature` / `userType`.
- `requestId` and/or `x-modelgov-request-id` (see [API correlation](../api.md#request-correlation)).
- Observed vs expected behavior; error `code` and `reasonCode` if present.
- Deployment mode (self-hosted managed, compose, k8s) and Modelgov image
  tag/digest.
- Relevant `/metrics` snapshot for availability/latency issues.

Related: [SLA](./sla.md) · [security questionnaire](./security-questionnaire.md) ·
[incident response](../runbooks/incident-response.md).
