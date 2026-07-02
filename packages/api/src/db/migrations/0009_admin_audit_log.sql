-- Tamper-evident admin/config audit log.
--
-- Every privileged mutation (key create/rotate/revoke, policy change, role
-- change, operator login) appends a row here. Each row's `row_hash` is a
-- SHA-256 over the previous row's hash plus this row's canonical content — a
-- hash chain. Altering or deleting any historical row breaks every subsequent
-- hash, so tampering is detectable by re-walking the chain (see verifyAuditChain).

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          bigserial    PRIMARY KEY,
  created_at  timestamptz  NOT NULL,
  actor       text         NOT NULL,
  action      text         NOT NULL,
  target      text,
  metadata    jsonb        NOT NULL DEFAULT '{}'::jsonb,
  prev_hash   text         NOT NULL,
  row_hash    text         NOT NULL
);

CREATE INDEX IF NOT EXISTS admin_audit_log_created_at_idx ON admin_audit_log (created_at);
CREATE INDEX IF NOT EXISTS admin_audit_log_action_idx ON admin_audit_log (action);
