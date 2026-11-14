# syntax=docker/dockerfile:1

# Stage 1: build the static site.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The image only builds if the type check and both check suites pass.
RUN npm run verify && npm run build

# Stage 2: serve it. The final image holds nginx and the exported files only,
# and runs as a non-root user on port 8080.
FROM nginxinc/nginx-unprivileged:stable-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/out /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
