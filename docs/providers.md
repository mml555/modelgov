# Providers

Ai-Guard is **provider-agnostic**: it decides policy, then hands execution to
**LiteLLM**, which talks to the actual provider. So "adding a provider" means
three things:

1. Point a `model_classes` entry at the provider's model string.
2. Give LiteLLM the credentials + routing for that model.
3. If the model isn't in Ai-Guard's built-in price table, add a
   [`pricing`](./configuration.md#pricing-optional--custom-token-prices) entry so
   budgets estimate correctly.

`npx create-ai-guard` wires all three for you — pick a provider in the wizard
(OpenAI, Anthropic, Gemini, OpenRouter, Azure OpenAI) and it generates the
`ai-guard.yaml` (with `pricing` for non-table models), the LiteLLM config, and
the right `.env` keys.

> Note: `create-ai-guard` is not yet published to npm. Until then, run it from
> source — see [self-host.md](./self-host.md).

## Provider reference

| Provider | Model string example | LiteLLM env | Notes |
| --- | --- | --- | --- |
| **OpenAI** | `openai/gpt-4o-mini` | `OPENAI_API_KEY` | In the built-in price table |
| **Anthropic** | `anthropic/claude-sonnet` | `ANTHROPIC_API_KEY` | In the built-in price table |
| **Gemini** | `gemini/gemini-1.5-pro` | `GEMINI_API_KEY` | Add `pricing` for exact rates |
| **OpenRouter** | `openrouter/anthropic/claude-3.5-sonnet` | `OPENROUTER_API_KEY` | Add `pricing` (see below) |
| **Azure OpenAI** | `azure/<deployment>` | `AZURE_API_KEY`, `AZURE_API_BASE`, `AZURE_API_VERSION` | Model = your **deployment** name |
| **Bedrock** | `bedrock/anthropic.claude-3-5-sonnet-...` | AWS creds (`AWS_*`) | Add `pricing` |
| **Ollama / local** | `ollama/llama3.2:3b` | — (`api_base`) | Price-exempt; use token budgets |

### OpenRouter

```yaml
# ai-guard.yaml
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
# ai-guard.yaml
model_classes:
  cheap: { primary: azure/gpt-4o-mini }   # "gpt-4o-mini" is YOUR deployment name
pricing:
  "azure/gpt-4o-mini": { input_per_1k: 0.00015, output_per_1k: 0.0006 }
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

### Anything LiteLLM supports

Bedrock, Vertex, Mistral, Cohere, Together, Groq, self-hosted vLLM, … all work
the same way: name the model in `model_classes`, add a `model_list` entry with
the provider's params, and add a `pricing` entry if it's not in the built-in
table. Ai-Guard's budgets, tokens, safety, routing, and audit apply uniformly
regardless of provider.

## Why pricing matters here

For models outside the built-in table (OpenRouter, Azure deployments, Bedrock),
Ai-Guard can't know the rate. Without a `pricing` entry it falls back to a
conservative default — fine to run, but your USD budgets won't match reality.
Declare the price and both the **reservation estimate** and the **settled-cost
fallback** use it. (Token budgets work regardless of price.)
