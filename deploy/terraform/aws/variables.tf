variable "name" {
  description = "Name prefix for all created resources (e.g. \"ai-guard-prod\")."
  type        = string
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default     = {}
}

# ── Network ──────────────────────────────────────────────────────────────────
variable "vpc_id" {
  description = "VPC to place the data tier in."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnet IDs (>=2 in different AZs) for the DB/Redis subnet groups."
  type        = list(string)
  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "Provide at least two subnets in different AZs for a highly-available data tier."
  }
}

variable "allowed_security_group_ids" {
  description = "Security groups allowed to reach Postgres/Redis (e.g. the EKS node group SG)."
  type        = list(string)
  default     = []
}

variable "allowed_cidr_blocks" {
  description = "CIDRs allowed to reach Postgres/Redis. Prefer allowed_security_group_ids."
  type        = list(string)
  default     = []
}

# ── Postgres (RDS) ───────────────────────────────────────────────────────────
variable "postgres_version" {
  description = "RDS PostgreSQL engine version."
  type        = string
  default     = "16.4"
}

variable "postgres_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.medium"
}

variable "postgres_allocated_storage" {
  description = "Initial storage (GiB)."
  type        = number
  default     = 50
}

variable "postgres_max_allocated_storage" {
  description = "Storage autoscaling ceiling (GiB)."
  type        = number
  default     = 200
}

variable "postgres_multi_az" {
  description = "Multi-AZ standby for automatic failover (HA). Keep true in production."
  type        = bool
  default     = true
}

variable "postgres_db_name" {
  description = "Initial database name."
  type        = string
  default     = "aiguard"
}

variable "postgres_username" {
  description = "Master username."
  type        = string
  default     = "aiguard"
}

variable "postgres_backup_retention_days" {
  description = "Automated backup retention (days). 0 disables backups (not for prod)."
  type        = number
  default     = 14
}

variable "postgres_deletion_protection" {
  description = "Block accidental deletion of the database."
  type        = bool
  default     = true
}

# ── Redis (ElastiCache) ──────────────────────────────────────────────────────
variable "redis_enabled" {
  description = "Provision ElastiCache Redis (shared rate limits across API replicas)."
  type        = bool
  default     = true
}

variable "redis_version" {
  description = "ElastiCache Redis engine version."
  type        = string
  default     = "7.1"
}

variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.small"
}

variable "redis_replicas" {
  description = "Replicas per node group. >=1 enables automatic failover (HA)."
  type        = number
  default     = 1
}

# ── Kubernetes secret wiring ─────────────────────────────────────────────────
variable "create_k8s_secret" {
  description = "Create a Kubernetes Secret with DATABASE_URL/REDIS_URL for the Helm chart's secret.existingSecret. Requires the kubernetes provider configured in the root module."
  type        = bool
  default     = false
}

variable "k8s_secret_name" {
  description = "Name of the Kubernetes Secret to create."
  type        = string
  default     = "ai-guard-secrets"
}

variable "k8s_namespace" {
  description = "Namespace for the Kubernetes Secret."
  type        = string
  default     = "default"
}

variable "ai_guard_api_key" {
  description = "Optional AI_GUARD_API_KEY to include in the created secret. Leave empty to manage it separately."
  type        = string
  default     = ""
  sensitive   = true
}
