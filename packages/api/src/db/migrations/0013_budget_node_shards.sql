-- Counter sharding for hot (org/global) budget nodes (see docs/design/multi-tenancy.md).
--
-- A single counter row is a throughput ceiling at high RPS: every request
-- contends on it. Marking a node with shard_count > 1 splits its counter into N
-- rows; a request reserves against shard = hash(shardKey) % N with a per-shard
-- sub-cap of cap_usd / N. This trades one hot row for N cooler rows and enforces
-- the cap within shard-imbalance bounds (the standard sharded-counter tradeoff).
-- Unsharded nodes keep shard_count = 1 and always use shard 0 (unchanged).

ALTER TABLE budget_nodes
  ADD COLUMN IF NOT EXISTS shard_count integer NOT NULL DEFAULT 1;

ALTER TABLE budget_node_counters
  ADD COLUMN IF NOT EXISTS shard integer NOT NULL DEFAULT 0;

-- Repartition the counter PK to include the shard.
ALTER TABLE budget_node_counters DROP CONSTRAINT IF EXISTS budget_node_counters_pkey;
ALTER TABLE budget_node_counters ADD PRIMARY KEY (node_id, window_start, shard);
