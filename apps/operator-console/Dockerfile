# Operator console: build the static bundle, serve it from a non-root nginx.
# Build context is this directory (apps/operator-console) — the console has no
# workspace dependencies, so it installs and builds standalone.
#
#   docker build -t modelgov-operator-console apps/operator-console
#   docker run -p 8080:8080 modelgov-operator-console
#
# The API base URL is entered at login (persisted per-session), so ONE image
# serves any deployment — no rebuild per environment.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-package-lock --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
