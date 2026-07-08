# Modelgov one-command ops. Make targets are aliases for ./setup or the CLI.
#   make setup      first-run setup, stack start, readiness wait, smoke test
#   make start      API + demo LLM + LiteLLM + Postgres + Presidio
#   make stop       stop the default stack
#   make start-full plus Langfuse observability
#   make start-local Ollama-only provider mode
#   make start-cloud real OpenAI/Anthropic provider mode
#   make start-azure Azure OpenAI provider mode
#   make up-prod    production compose
#   make status     containers plus /health and /ready

.PHONY: setup start start-full start-local start-cloud start-azure start-prod stop stop-full stop-local stop-cloud stop-azure stop-prod status status-full status-local status-cloud status-azure doctor doctor-full doctor-local doctor-cloud doctor-azure smoke reset up up-full up-local up-cloud up-azure up-prod down down-full down-local down-cloud down-azure down-prod logs logs-full logs-local logs-cloud logs-azure test test-db smoke-ci build install build-image

CLI := pnpm --filter @modelgov/cli dev --

setup:
	./setup

start:
	$(CLI) up simple

stop:
	$(CLI) down simple

status:
	$(CLI) status simple

status-full:
	$(CLI) status full

status-local:
	$(CLI) status local

status-cloud:
	$(CLI) status cloud

status-azure:
	$(CLI) status azure

doctor:
	$(CLI) doctor simple

doctor-full:
	$(CLI) doctor full

doctor-local:
	$(CLI) doctor local

doctor-cloud:
	$(CLI) doctor cloud

doctor-azure:
	$(CLI) doctor azure

smoke:
	$(CLI) smoke simple

reset:
	$(CLI) reset simple --yes

up:
	$(MAKE) start

up-full:
	$(CLI) up full

up-local:
	$(CLI) up local

up-cloud:
	$(CLI) up cloud

up-azure:
	$(CLI) up azure

up-prod:
	$(CLI) up prod

down:
	$(MAKE) stop

down-full:
	$(CLI) down full

down-local:
	$(CLI) down local

down-cloud:
	$(CLI) down cloud

down-azure:
	$(CLI) down azure

down-prod:
	$(CLI) down prod

logs-local:
	$(CLI) logs local

logs:
	$(CLI) logs simple

logs-full:
	$(CLI) logs full

logs-cloud:
	$(CLI) logs cloud

logs-azure:
	$(CLI) logs azure

start-full: up-full
start-local: up-local
start-cloud: up-cloud
start-azure: up-azure
start-prod: up-prod
stop-full: down-full
stop-local: down-local
stop-cloud: down-cloud
stop-azure: down-azure
stop-prod: down-prod

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
