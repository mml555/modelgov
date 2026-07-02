# Build the Ai-Guard API. Multi-stage: build the whole workspace, then ship a
# runtime that bundles our workspace code and installs only the third-party deps
# the bundle leaves external (fastify, pg, jose, …).

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ai-guard/policy-engine build \
 && pnpm --filter @ai-guard/api build
# Derive the runtime dependency manifest from packages/api/package.json so the
# runtime install can never drift from what the bundle externalizes. Pins the
# exact installed (locked) versions. See scripts/gen-runtime-pkg.mjs.
RUN node packages/api/scripts/gen-runtime-pkg.mjs

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Install exactly the externalized third-party deps (generated, not hand-listed).
COPY --from=build /app/packages/api/dist/runtime-package.json ./package.json
# After the install, strip npm/corepack/yarn from the image: the runtime CMD
# only ever runs `node`, and the package managers' own vendored dependencies
# (e.g. npm's bundled picomatch) otherwise ship CVEs the app never executes.
RUN npm install --omit=dev --no-package-lock --no-audit --no-fund \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
           /root/.npm
COPY --from=build /app/packages/api/dist ./dist
COPY ai-guard.yaml ./ai-guard.yaml
# Run as the unprivileged `node` user shipped in the base image, not root.
RUN chown -R node:node /app
USER node
EXPOSE 3000
# `exec` replaces the shell with the server process so it becomes PID 1 and
# receives SIGTERM directly — without it the shell holds PID 1 and never forwards
# the signal, leaving the graceful-shutdown drain in bootstrap.ts unreachable and
# every deploy/scale-down a hard kill of in-flight requests.
CMD ["sh", "-c", "node dist/migrate.js && exec node dist/index.js"]
