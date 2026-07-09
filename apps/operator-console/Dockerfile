# Operator console: build from the monorepo root so workspace packages
# (@modelgov/policy-engine, create-modelgov) resolve under pnpm.
#
#   docker build -f apps/operator-console/Dockerfile -t modelgov-operator-console .
#   docker run -p 8080:8080 modelgov-operator-console
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
RUN mkdir -p apps/operator-console packages/policy-engine packages/create-modelgov
COPY apps/operator-console/package.json apps/operator-console/package.json
COPY packages/policy-engine/package.json packages/policy-engine/package.json
COPY packages/create-modelgov/package.json packages/create-modelgov/package.json
RUN pnpm install --frozen-lockfile --filter @modelgov/operator-console...

COPY apps/operator-console apps/operator-console
COPY packages/policy-engine packages/policy-engine
COPY packages/create-modelgov packages/create-modelgov
RUN pnpm --filter @modelgov/policy-engine build \
  && pnpm --filter @modelgov/operator-console build

FROM nginxinc/nginx-unprivileged:alpine
COPY --from=build /app/apps/operator-console/dist /usr/share/nginx/html
COPY apps/operator-console/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
