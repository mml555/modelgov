# Build the Modelgov API. Multi-stage: build the whole workspace, then ship a
# runtime that bundles our workspace code and carries only the third-party deps
# the bundle leaves external (fastify, pg, jose, …).

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

# Install dependencies from lockfile + workspace manifests first. Keeping source,
# docs, and examples out of this layer makes repeated `./setup` runs reuse the
# expensive pnpm install cache unless dependencies actually changed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
RUN mkdir -p \
  apps/operator-console \
  examples/chatbot \
  examples/document_extraction \
  examples/event_intake_app \
  examples/nextjs_support_chat \
  examples/ocr_pipeline \
  examples/rag_support \
  examples/saas_tiers \
  examples/support_chat \
  packages/api \
  packages/cli \
  packages/create-modelgov \
  packages/policy-engine \
  packages/sdk-typescript
COPY apps/operator-console/package.json apps/operator-console/package.json
COPY examples/chatbot/package.json examples/chatbot/package.json
COPY examples/document_extraction/package.json examples/document_extraction/package.json
COPY examples/event_intake_app/package.json examples/event_intake_app/package.json
COPY examples/nextjs_support_chat/package.json examples/nextjs_support_chat/package.json
COPY examples/ocr_pipeline/package.json examples/ocr_pipeline/package.json
COPY examples/rag_support/package.json examples/rag_support/package.json
COPY examples/saas_tiers/package.json examples/saas_tiers/package.json
COPY examples/support_chat/package.json examples/support_chat/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/create-modelgov/package.json packages/create-modelgov/package.json
COPY packages/policy-engine/package.json packages/policy-engine/package.json
COPY packages/sdk-typescript/package.json packages/sdk-typescript/package.json
RUN pnpm install --frozen-lockfile

# The API image only needs API + policy-engine source to build. Avoid copying
# repo docs/examples here so documentation changes do not invalidate API builds.
COPY packages/api packages/api
COPY packages/policy-engine packages/policy-engine
RUN pnpm --filter @modelgov/policy-engine build \
 && pnpm --filter @modelgov/api build
# Produce a self-contained, production-only deployment of the API whose
# node_modules is resolved ENTIRELY from the frozen workspace lockfile
# (pnpm-lock.yaml) — direct AND transitive versions come from lockfile truth,
# with no fresh re-resolution. This is what makes the runtime image
# reproducible: the same commit yields the same dependency tree every build.
# It also derives the dep set straight from packages/api/package.json, so the
# runtime can't drift from what the bundle externalizes (add a dep -> it ships).
# Target is OUTSIDE the workspace root (/app) — deploying into a subdir of the
# workspace trips ERR_PNPM_DEPLOY_DIR_NOT_EMPTY. --legacy uses the stable deploy
# implementation (the default in pnpm 10 is still experimental).
RUN pnpm --filter @modelgov/api --prod --legacy deploy /deploy

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Copy the lockfile-faithful production node_modules and its manifest. No install
# step runs in the runtime stage, so nothing re-resolves at build time — and npm
# never executes, so its own vendored deps (e.g. the bundled picomatch that
# tripped CVE-2026-33671) can't enter the image.
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /deploy/package.json ./package.json
# Ship our bundled app code (tsup output; workspace deps inlined into dist).
COPY --from=build /app/packages/api/dist ./dist
COPY modelgov.yaml ./modelgov.yaml
# Strip npm/corepack/yarn shipped in the base image: the runtime CMD only ever
# runs `node`, and the package managers' vendored dependencies otherwise ship
# CVEs the app never executes.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
           /root/.npm \
 && chown -R node:node /app
# Run as the unprivileged `node` user shipped in the base image, not root.
USER node
EXPOSE 3000
# `exec` replaces the shell with the server process so it becomes PID 1 and
# receives SIGTERM directly — without it the shell holds PID 1 and never forwards
# the signal, leaving the graceful-shutdown drain in bootstrap.ts unreachable and
# every deploy/scale-down a hard kill of in-flight requests.
CMD ["sh", "-c", "node dist/migrate.js && exec node dist/index.js"]
