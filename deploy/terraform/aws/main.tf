locals {
  tags = merge({ "app.kubernetes.io/managed-by" = "terraform", "app" = "ai-guard" }, var.tags)
}

# ── Credentials ──────────────────────────────────────────────────────────────
resource "random_password" "postgres" {
  length  = 32
  special = false # avoid URL-encoding hazards in DATABASE_URL
}

resource "random_password" "redis" {
  count   = var.redis_enabled ? 1 : 0
  length  = 32
  special = false
}

# ── Postgres (RDS) ───────────────────────────────────────────────────────────
resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-pg"
  subnet_ids = var.subnet_ids
  tags       = local.tags
}

resource "aws_security_group" "postgres" {
  name        = "${var.name}-pg"
  description = "Ai-Guard Postgres access"
  vpc_id      = var.vpc_id
  tags        = local.tags
}

resource "aws_security_group_rule" "postgres_from_sg" {
  count                    = length(var.allowed_security_group_ids)
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  security_group_id        = aws_security_group.postgres.id
  source_security_group_id = var.allowed_security_group_ids[count.index]
}

resource "aws_security_group_rule" "postgres_from_cidr" {
  count             = length(var.allowed_cidr_blocks) > 0 ? 1 : 0
  type              = "ingress"
  from_port         = 5432
  to_port           = 5432
  protocol          = "tcp"
  security_group_id = aws_security_group.postgres.id
  cidr_blocks       = var.allowed_cidr_blocks
}

resource "aws_db_instance" "this" {
  identifier     = "${var.name}-pg"
  engine         = "postgres"
  engine_version = var.postgres_version
  instance_class = var.postgres_instance_class

  allocated_storage     = var.postgres_allocated_storage
  max_allocated_storage = var.postgres_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = var.postgres_db_name
  username = var.postgres_username
  password = random_password.postgres.result
  port     = 5432

  multi_az               = var.postgres_multi_az
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.postgres.id]

  backup_retention_period    = var.postgres_backup_retention_days
  auto_minor_version_upgrade = true
  deletion_protection        = var.postgres_deletion_protection
  # Snapshot on destroy unless deletion protection is off (dev).
  skip_final_snapshot       = !var.postgres_deletion_protection
  final_snapshot_identifier = var.postgres_deletion_protection ? "${var.name}-pg-final" : null

  performance_insights_enabled = true
  tags                         = local.tags
}

# ── Redis (ElastiCache) ──────────────────────────────────────────────────────
resource "aws_elasticache_subnet_group" "this" {
  count      = var.redis_enabled ? 1 : 0
  name       = "${var.name}-redis"
  subnet_ids = var.subnet_ids
  tags       = local.tags
}

resource "aws_security_group" "redis" {
  count       = var.redis_enabled ? 1 : 0
  name        = "${var.name}-redis"
  description = "Ai-Guard Redis access"
  vpc_id      = var.vpc_id
  tags        = local.tags
}

resource "aws_security_group_rule" "redis_from_sg" {
  count                    = var.redis_enabled ? length(var.allowed_security_group_ids) : 0
  type                     = "ingress"
  from_port                = 6379
  to_port                  = 6379
  protocol                 = "tcp"
  security_group_id        = aws_security_group.redis[0].id
  source_security_group_id = var.allowed_security_group_ids[count.index]
}

resource "aws_security_group_rule" "redis_from_cidr" {
  count             = var.redis_enabled && length(var.allowed_cidr_blocks) > 0 ? 1 : 0
  type              = "ingress"
  from_port         = 6379
  to_port           = 6379
  protocol          = "tcp"
  security_group_id = aws_security_group.redis[0].id
  cidr_blocks       = var.allowed_cidr_blocks
}

resource "aws_elasticache_replication_group" "this" {
  count                = var.redis_enabled ? 1 : 0
  replication_group_id = "${var.name}-redis"
  description          = "Ai-Guard rate-limit Redis"

  engine         = "redis"
  engine_version = var.redis_version
  node_type      = var.redis_node_type
  port           = 6379

  # HA: >=1 replica with automatic failover across AZs.
  num_cache_clusters         = 1 + var.redis_replicas
  automatic_failover_enabled = var.redis_replicas >= 1
  multi_az_enabled           = var.redis_replicas >= 1

  subnet_group_name  = aws_elasticache_subnet_group.this[0].name
  security_group_ids = [aws_security_group.redis[0].id]

  # Encrypt in transit (TLS -> rediss://) and at rest, with an AUTH token.
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true
  auth_token                 = random_password.redis[0].result

  snapshot_retention_limit = 7
  tags                     = local.tags
}

# ── Optional: wire outputs into a Kubernetes Secret for the Helm chart ─────────
resource "kubernetes_secret" "ai_guard" {
  count = var.create_k8s_secret ? 1 : 0

  metadata {
    name      = var.k8s_secret_name
    namespace = var.k8s_namespace
    labels    = { "app.kubernetes.io/name" = "ai-guard" }
  }

  # Keys match what the Helm chart's deployment expects via envFrom.
  data = merge(
    {
      DATABASE_URL = local.database_url
    },
    var.redis_enabled ? { REDIS_URL = local.redis_url } : {},
    var.ai_guard_api_key != "" ? { AI_GUARD_API_KEY = var.ai_guard_api_key } : {},
  )

  type = "Opaque"
}
