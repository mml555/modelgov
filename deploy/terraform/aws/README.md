# Modelgov data tier (AWS)

Terraform module that provisions the **managed data tier** Modelgov needs in
production — RDS PostgreSQL and (optionally) ElastiCache Redis — with HA defaults,
and can wire the connection strings straight into the Kubernetes Secret the Helm
chart consumes.

The API itself runs from the [Helm chart](../../helm/modelgov/); this module is
the "you supply the data tier" half that the chart deliberately does not manage.

## What it creates

| Resource | HA defaults |
| --- | --- |
| `aws_db_instance` (PostgreSQL) | Multi-AZ standby, storage encrypted, gp3 autoscaling, 14-day backups, deletion protection, final snapshot |
| `aws_elasticache_replication_group` (Redis) | 1 replica + automatic failover, Multi-AZ, TLS in transit (`rediss://`) + AUTH token, encryption at rest |
| Security groups | Ingress on 5432/6379 only from your node-group SG (or CIDRs) |
| `kubernetes_secret` *(optional)* | `DATABASE_URL` + `REDIS_URL` (+ `MODELGOV_API_KEY`) for `secret.existingSecret` |

## Usage

```hcl
module "modelgov_data" {
  source = "github.com/your-org/modelgov//deploy/terraform/aws"

  name                       = "modelgov-prod"
  vpc_id                     = var.vpc_id
  subnet_ids                 = var.private_subnet_ids          # >= 2 AZs
  allowed_security_group_ids = [module.eks.node_security_group_id]

  # Optional: let Terraform create the k8s Secret the chart reads.
  create_k8s_secret = true
  k8s_namespace     = "modelgov"
  k8s_secret_name   = "modelgov-secrets"
}

output "database_url" {
  value     = module.modelgov_data.database_url
  sensitive = true
}
```

Then point the chart at the secret:

```yaml
# values.yaml
secret:
  existingSecret: modelgov-secrets
production: true            # refuses floating image tags (see chart README)
postgres: { enabled: false }
redis:    { enabled: false, url: "" }   # external Redis from this module
```

If you set `create_k8s_secret = true`, configure the `kubernetes` provider in your
**root** module (this module does not configure providers):

```hcl
provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
  # token/exec auth ...
}
```

## Notes

- **Secrets in state.** `DATABASE_URL`/`REDIS_URL` outputs and the generated
  passwords live in Terraform state — use an encrypted remote backend (S3 +
  KMS) and restrict access. Rotate by tainting the `random_password` resources.
- **Not validated in CI here.** This is standard AWS provider HCL; run
  `terraform init && terraform validate && terraform plan` in your environment
  (with credentials) before applying. `terraform fmt -check` keeps it tidy.
- **Cost/scale knobs** (`*_instance_class`, `*_node_type`, `redis_replicas`,
  storage) all have variables — size them from the
  [benchmarks](../../../docs/deployment/benchmarks.md).
