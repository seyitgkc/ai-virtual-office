# syntax=docker/dockerfile:1

# Stage 1: install, check and build.
FROM node:26-alpine AS build
WORKDIR /app
# No usage data is sent to the framework's vendor, at build time or at run time.
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The image only builds if the type check and every check script pass.
RUN npm run verify && npm run build

# Stage 2: the server on its own. Next's standalone output carries only the
# files the server needs, and it runs as a non-root user.
FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    OFFICE_DB_PATH=/data/office.db
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# The database and the token signing key live on a volume mounted here.
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/login || exit 1
CMD ["node", "server.js"]
