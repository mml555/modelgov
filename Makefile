# Modelgov one-command ops. Make targets are aliases for the CLI.
#   make setup      first-run setup, stack start, readiness wait, smoke test
#   make up         API + LiteLLM + Postgres + Presidio
#   make up-full    plus Langfuse observability
#   make up-local   Ollama-only provider mode
#   make up-prod    production compose
#   make status     containers plus /health and /ready

.PHONY: setup status status-full status-local doctor doctor-full doctor-local smoke reset up up-full up-local up-prod down down-full down-local down-prod logs logs-full logs-local test test-db smoke-ci build install build-image

CLI := pnpm --filter @modelgov/cli dev --

setup:
	$(CLI) setup simple

status:
	$(CLI) status simple

status-full:
	$(CLI) status full

status-local:
	$(CLI) status local

doctor:
	$(CLI) doctor simple

doctor-full:
	$(CLI) doctor full

doctor-local:
	$(CLI) doctor local

smoke:
	$(CLI) smoke simple

reset:
	$(CLI) reset simple --yes

up:
	$(CLI) up simple

up-full:
	$(CLI) up full

up-local:
	$(CLI) up local

up-prod:
	$(CLI) up prod

down:
	$(CLI) down simple

down-full:
	$(CLI) down full

down-local:
	$(CLI) down local

down-prod:
	$(CLI) down prod

logs-local:
	$(CLI) logs local

logs:
	$(CLI) logs simple

logs-full:
	$(CLI) logs full

install:
	pnpm install

build:
	pnpm install && pnpm build

build-image:
	@bash scripts/build-api-image.sh

test:
	pnpm test

test-db:
	@bash scripts/test-with-db.sh

smoke-ci:
	@bash scripts/smoke-ci.sh
