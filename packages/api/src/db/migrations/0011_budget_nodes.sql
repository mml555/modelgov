-- Hierarchical budgets (see docs/design/multi-tenancy.md).
--
-- A budget_nodes tree (org → dept → team → user → feature) replaces the flat
-- user_daily / feature_monthly / global dimensions. A request maps to a leaf
-- path; every node on the path with a cap is a budget dimension it must satisfy.
-- This ships alongside the existing flat budget_counters path (kept as default);
-- nothing here is wired into /v1/chat yet.

CREATE TABLE IF NOT EXISTS budget_nodes (
  id           bigserial     PRIMARY KEY,
  tenant_id    text          NOT NULL,
  parent_id    bigint        REFERENCES budget_nodes(id) ON DELETE CASCADE,
  -- Advisory label of where the node sits in the tree.
  kind         text          NOT NULL,   -- org | dept | team | user | feature
  name         text          NOT NULL,
  -- Which calendar window this node's cap resets on.
  budget_window text         NOT NULL DEFAULT 'monthly',  -- daily | monthly
  cap_usd      numeric(14, 6),           -- NULL = no USD cap at this level
  request_cap  integer,                  -- NULL = no request cap at this level
  created_at   timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS budget_nodes_parent_idx ON budget_nodes (parent_id);
CREATE INDEX IF NOT EXISTS budget_nodes_tenant_idx ON budget_nodes (tenant_id);

-- Per-node spend counters, one row per (node, window bucket). Mirrors the
-- semantics of budget_counters but keyed by node_id.
CREATE TABLE IF NOT EXISTS budget_node_counters (
  node_id       bigint        NOT NULL REFERENCES budget_nodes(id) ON DELETE CASCADE,
  window_start  date          NOT NULL,
  used_usd      numeric(14, 6) NOT NULL DEFAULT 0,
  reserved_usd  numeric(14, 6) NOT NULL DEFAULT 0,
  requests_used integer        NOT NULL DEFAULT 0,
  PRIMARY KEY (node_id, window_start)
);
