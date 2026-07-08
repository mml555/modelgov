# Providers

Modelgov is **provider-agnostic**: it decides policy, then hands execution to
**LiteLLM**, which talks to the actual provider. So "adding a provider" means
three things:

1. Point a `model_classes` entry at the provider's model string.
2. Give LiteLLM the credentials + routing for that model.
3. If the model isn't in Modelgov's built-in price table, add a
   [`pricing`](./configuration.md#pricing-optional--custom-token-prices) entry so
   budgets estimate correctly.

`npx create-modelgov` wires all three for you — pick one or more providers in the
wizard (OpenAI, Anthropic, Gemini, OpenRouter, Azure OpenAI, Azure AI Foundry,
AWS Bedrock, Google Vertex, Mistral, Groq, xAI, DeepSeek, Cohere, GitHub Copilot)
and it generates the `modelgov.yaml`, the LiteLLM config (with the correct auth
wiring per provider), and the `.env` keys.

> Note: `create-modelgov` is not yet published to npm. Until then, run it from
> source — see [self-host.md](./self-host.md).

Modelgov keeps a **provider registry** (`@modelgov/policy-engine`'s
`providers.ts`) as the single source of truth for each provider's auth style,
billing style, credential env vars, and built-in prices. That's why the
providers below are turnkey — their common models are already in the built-in
price table, so USD budgets estimate correctly without a `pricing` block.

## Provider reference

| Provider | Model string example | LiteLLM env | Notes |
| --- | --- | --- | --- |
| **OpenAI** | `openai/gpt-4o-mini` | `OPENAI_API_KEY` | Built-in price table |
| **Anthropic** | `anthropic/claude-sonnet` | `ANTHROPIC_API_KEY` | Built-in price table |
| **Gemini (AI Studio)** | `gemini/gemini-1.5-pro` | `GEMINI_API_KEY` | Built-in price table |
| **Azure OpenAI** | `azure/<deployment>` | `AZURE_API_KEY`, `AZURE_API_BASE`, `AZURE_API_VERSION` | Model = your **deployment** name; common names in built-in price table |
| **Azure AI Foundry** | `azure_ai/<deployment>` | `AZURE_AI_API_KEY`, `AZURE_AI_API_BASE` | Unified Foundry endpoint; Claude uses `/anthropic` suffix on `api_base` |
| **AWS Bedrock** | `bedrock/anthropic.claude-3-5-sonnet-...` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION_NAME` | Built-in price table (Claude models) |
| **Google Vertex** | `vertex_ai/gemini-1.5-pro` | `GOOGLE_APPLICATION_CREDENTIALS`, `VERTEX_PROJECT`, `VERTEX_LOCATION` | Built-in price table (Gemini) |
| **Mistral** | `mistral/mistral-large-latest` | `MISTRAL_API_KEY` | Built-in price table |
| **Groq** | `groq/llama-3.3-70b-versatile` | `GROQ_API_KEY` | Built-in price table |
| **xAI (Grok)** | `xai/grok-2-latest` | `XAI_API_KEY` | Built-in price table |
| **DeepSeek** | `deepseek/deepseek-chat` | `DEEPSEEK_API_KEY` | Built-in price table |
| **Cohere** | `cohere/command-r-plus` | `COHERE_API_KEY` | Built-in price table |
| **GitHub Copilot** | `github_copilot/gpt-4o` | OAuth device flow (`GITHUB_COPILOT_TOKEN`) | **Subscription** — $0 USD reserved; governed by token/request budgets |
| **OpenRouter** | `openrouter/anthropic/claude-3.5-sonnet` | `OPENROUTER_API_KEY` | Priced per route — add `pricing` (see below) |
| **Ollama / local** | `ollama/llama3.2:3b` | — (`api_base`) | Price-exempt; use token budgets |

> Built-in prices are best-effort snapshots. When a provider's exact rate matters
> for USD budgets, override it with a `pricing` entry — both the reservation
> estimate and the settled-cost fallback use it.

### OpenRouter

```yaml
# modelgov.yaml
model_classes:
  standard: { primary: openrouter/anthropic/claude-3.5-sonnet }
pricing:
  "openrouter/anthropic/claude-3.5-sonnet": { input_per_1k: 0.003, output_per_1k: 0.015 }
```

```yaml
# litellm_config.yaml
model_list:
  - model_name: openrouter/anthropic/claude-3.5-sonnet
    litellm_params:
      model: openrouter/anthropic/claude-3.5-sonnet
      api_key: os.environ/OPENROUTER_API_KEY
```

### Azure OpenAI

Azure routes by **deployment name**, and needs the endpoint + API version:

```yaml
# modelgov.yaml
model_classes:
  cheap: { primary: azure/gpt-4o-mini }   # "gpt-4o-mini" is YOUR deployment name
```

Built-in pricing covers common deployment names (`azure/gpt-4o-mini`, `azure/gpt-4o`,
`azure/gpt-5`). Custom deployment names still need a `pricing` entry:

```yaml
pricing:
  "azure/my-custom-deployment": { input_per_1k: 0.00015, output_per_1k: 0.0006 }
```

```yaml
# litellm_config.yaml
model_list:
  - model_name: azure/gpt-4o-mini
    litellm_params:
      model: azure/gpt-4o-mini
      api_key: os.environ/AZURE_API_KEY
      api_base: os.environ/AZURE_API_BASE       # https://<resource>.openai.azure.com
      api_version: os.environ/AZURE_API_VERSION # e.g. 2024-08-01-preview
```

**Local dev:** from the repo root, `make start-azure` (or `modelgov up azure`) layers
`docker-compose.azure.yml` over the simple stack, mounts `modelgov.azure.example.yaml`,
and wires LiteLLM to `litellm_config.azure.yaml`. Copy `.env.azure.example` → `.env`
and set `AZURE_API_KEY`, `AZURE_API_BASE`, and `AZURE_API_VERSION`.

**Helm:** use `deploy/helm/modelgov/values-azure.yaml` with your Azure secrets in
`secret.providerKeys`.

For **Azure AD / managed identity** instead of an API key, set `azure_ad_token` in
`litellm_params` (see [LiteLLM Azure docs](https://docs.litellm.ai/docs/providers/azure)).

### Azure AI Foundry

Azure AI Foundry (LiteLLM provider `azure_ai`) routes by **deployment/model name**
and uses the Foundry services endpoint — no `api_version`:

```yaml
# modelgov.yaml
model_classes:
  cheap: { primary: azure_ai/gpt-4o-mini }
  premium: { primary: azure_ai/claude-opus-4-1 }  # Foundry-hosted Claude
```

Built-in pricing covers the wizard defaults (`azure_ai/gpt-4o-mini`, `azure_ai/gpt-4o`,
`azure_ai/claude-opus-4-1`). Custom deployment names need a `pricing` entry.

```yaml
# litellm_config.yaml
model_list:
  - model_name: azure_ai/gpt-4o-mini
    litellm_params:
      model: azure_ai/gpt-4o-mini
      api_key: os.environ/AZURE_AI_API_KEY
      api_base: os.environ/AZURE_AI_API_BASE   # https://<resource>.services.ai.azure.com
  - model_name: azure_ai/claude-opus-4-1
    litellm_params:
      model: azure_ai/claude-opus-4-1
      api_key: os.environ/AZURE_AI_API_KEY
      api_base: os.environ/AZURE_AI_API_BASE   # https://<resource>.services.ai.azure.com/anthropic
```

Pick **Azure AI Foundry** in `create-modelgov` to generate all three files with the
correct model strings and env placeholders.

### AWS Bedrock

Bedrock authenticates with AWS credentials (from the LiteLLM container's env),
not an API key. Common Claude-on-Bedrock models are in the built-in price table.

```yaml
# modelgov.yaml
providers:
  bedrock: { auth: aws }   # informational; creds live in LiteLLM's env
model_classes:
  standard: { primary: bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0 }
```

```yaml
# litellm_config.yaml
model_list:
  - model_name: bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0
    litellm_params:
      model: bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0
      aws_access_key_id: os.environ/AWS_ACCESS_KEY_ID
      aws_secret_access_key: os.environ/AWS_SECRET_ACCESS_KEY
      aws_region_name: os.environ/AWS_REGION_NAME
```

For IAM roles / instance profiles instead of static keys, omit the key params and
let the AWS SDK resolve credentials from the environment (see the
[LiteLLM Bedrock docs](https://docs.litellm.ai/docs/providers/bedrock)).

### Google Vertex AI

Vertex authenticates with a GCP service account. Gemini-on-Vertex models are in
the built-in price table.

```yaml
# litellm_config.yaml
model_list:
  - model_name: vertex_ai/gemini-1.5-pro
    litellm_params:
      model: vertex_ai/gemini-1.5-pro
      vertex_project: os.environ/VERTEX_PROJECT
      vertex_location: os.environ/VERTEX_LOCATION
      # GOOGLE_APPLICATION_CREDENTIALS points at the service-account JSON.
```

### Mistral, Groq, xAI, DeepSeek, Cohere

These are plain API-key providers — pick them in the wizard, or wire them by hand:

```yaml
# modelgov.yaml
providers:
  groq: { api_key: env/GROQ_API_KEY }
model_classes:
  cheap: { primary: groq/llama-3.1-8b-instant }
```

```yaml
# litellm_config.yaml
model_list:
  - model_name: groq/llama-3.1-8b-instant
    litellm_params:
      model: groq/llama-3.1-8b-instant
      api_key: os.environ/GROQ_API_KEY
```

Their common models are in the built-in price table. Swap the slug/env
(`mistral`/`MISTRAL_API_KEY`, `xai`/`XAI_API_KEY`, `deepseek`/`DEEPSEEK_API_KEY`,
`cohere`/`COHERE_API_KEY`) for the others.

### GitHub Copilot (subscription)

GitHub Copilot is different in two ways, and Modelgov handles both:

**Auth — OAuth device flow.** LiteLLM performs a browser device-code login on
first use and caches the token. For a **headless proxy container**, do the login
once interactively (or on a workstation) and mount/inject the cached token so the
container doesn't block on a device prompt:

```yaml
# litellm_config.yaml
model_list:
  - model_name: github_copilot/gpt-4o
    litellm_params:
      model: github_copilot/gpt-4o
```

```bash
# One-time device login (prints a code to enter at github.com/login/device),
# then reuse the cached token in the proxy container:
#   litellm --config litellm_config.yaml   # follow the device prompt once
# Copy ~/.config/litellm/github_copilot/ into the container, or set:
#   GITHUB_COPILOT_TOKEN=<token>
```

**Billing — per-seat subscription, not per-token.** There is no per-token cost to
meter, so Modelgov **reserves $0 USD** for `github_copilot/*` models. Governance
still applies through **token and request budgets**:

```yaml
# modelgov.yaml
providers:
  github_copilot: { auth: oauth_device, billing: subscription }
budgets:
  by_user_type:
    logged_in:
      daily_usd: 100          # effectively unused for Copilot (always $0)
      daily_requests: 200     # ← the real lever
      daily_tokens: 500000    # ← the real lever
      models: [standard]
model_classes:
  standard: { primary: github_copilot/gpt-4o }
```

Modelgov recognizes `github_copilot` as subscription automatically (via the
provider registry). For a **custom or self-hosted** subscription gateway, mark it
yourself with `providers.<id>: { billing: subscription }` — its models will
reserve $0 USD too, while token/request budgets keep enforcing.

## Checking provider health

`GET /v1/admin/providers/health` (requires the `usage:read` permission) surfaces
the LiteLLM proxy's per-model health — which provider/model is up or down, with
the provider's error for unhealthy endpoints. It's read-only and does **not**
affect the `/ready` probe (readiness stays gated on the database only, so a
transient upstream blip never pulls a replica out of rotation).

## Why pricing matters here

For models outside the built-in table (OpenRouter, custom Azure/Bedrock
deployment names), Modelgov can't know the rate. Without a `pricing` entry it
falls back to a conservative default — fine to run, but your USD budgets won't
match reality. Declare the price and both the **reservation estimate** and the
**settled-cost fallback** use it. (Token budgets work regardless of price, and
subscription providers like Copilot are intentionally $0.)
