locals {
  # sslmode=require: RDS enforces TLS; the API also accepts DATABASE_SSL settings.
  database_url = format(
    "postgres://%s:%s@%s:%d/%s?sslmode=require",
    var.postgres_username,
    random_password.postgres.result,
    aws_db_instance.this.address,
    aws_db_instance.this.port,
    var.postgres_db_name,
  )

  # rediss:// because transit encryption is enabled; AUTH token in the userinfo.
  redis_url = var.redis_enabled ? format(
    "rediss://:%s@%s:6379",
    random_password.redis[0].result,
    aws_elasticache_replication_group.this[0].primary_endpoint_address,
  ) : ""
}

output "database_url" {
  description = "DATABASE_URL for Modelgov (set as the secret's DATABASE_URL)."
  value       = local.database_url
  sensitive   = true
}

output "redis_url" {
  description = "REDIS_URL for Modelgov (rediss:// with AUTH). Empty when redis is disabled."
  value       = local.redis_url
  sensitive   = true
}

output "postgres_address" {
  description = "RDS endpoint host."
  value       = aws_db_instance.this.address
}

output "postgres_security_group_id" {
  description = "Security group guarding Postgres — reference it from your node group SG."
  value       = aws_security_group.postgres.id
}

output "redis_primary_endpoint" {
  description = "ElastiCache primary endpoint host (empty when redis is disabled)."
  value       = var.redis_enabled ? aws_elasticache_replication_group.this[0].primary_endpoint_address : ""
}

output "k8s_secret_name" {
  description = "Name of the created Kubernetes Secret (when create_k8s_secret = true)."
  value       = var.create_k8s_secret ? var.k8s_secret_name : ""
}
