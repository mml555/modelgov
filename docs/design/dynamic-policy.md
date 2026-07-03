# Dynamic policy store — design & status

Moves policy off a static `modelgov.yaml` baked into the image and into a
**versioned, validated, auditable** store, so operators can change budgets,
safety rules, and routing without editing files in the image.

## Built (opt-in via `POLICY_STORE_ENABLED=true`)

- **Versioned store** — `config_versions` table; each version is immutable YAML
  with a SHA-256 checksum, author, and note. A partial unique index enforces
  **exactly one active version**.
- **Validation on write** — `POST /v1/admin/policy/versions` runs the full
  `parseConfig` validator; an invalid config is rejected `400 invalid_config`
  and never enters the store.
- **Activation & rollback** — `POST /v1/admin/policy/versions/:id/activate`
  flips the active version atomically. Rollback is just activating a prior id.
  Re-validates before flipping.
- **Audit** — `policy.save` and `policy.activate` are written to the
  tamper-evident audit log (`[audit]`), with actor + checksum.
- **Boot loading** — with the flag on, a replica loads the active version at
  boot; on an empty store it seeds version 1 from `MODELGOV_CONFIG`.
- **RBAC** — reads require `policy:read`, mutations `policy:write` (the
  `policy-admin` and `owner` roles).

## Roadmap (not yet built)

- **Zero-restart hot reload.** Today an activated version is applied on the next
  rolling restart (each replica reads the active version at boot). True hot
  reload requires routes to read config from a mutable provider that a
  DB `LISTEN/NOTIFY` (or short poll) refreshes on activation — a focused
  refactor of the `deps.config` capture in `buildServer`.
- **Approval workflow.** The store records author + note per version; a
  two-person-rule (propose → approve → activate) would add `proposed_by` /
  `approved_by` columns and a pending state, gated by a distinct
  `policy:approve` permission.
- **Structured diffs.** Version metadata is stored; a semantic diff between two
  versions (which budget/feature changed) would aid change review in the
  console.
- **Env interpolation.** Stored YAML is literal (no `${VAR}` expansion, unlike
  file loading). Provider keys are owned by LiteLLM, so this is usually moot;
  document it for operators who templated the file.

See [operations](../operations.md) for enabling the store and the
[HTTP API](../api.md) for the endpoints.
