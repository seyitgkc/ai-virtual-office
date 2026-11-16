# syntax=docker/dockerfile:1

# One image definition for every sample service. SERVICE picks which one, by
# the name of its folder. Each is plain TypeScript with no dependencies, run
# directly by Node, alongside the two files the services share.
FROM node:26-alpine
ARG SERVICE
WORKDIR /app
COPY shared.ts manifests.ts ./
COPY ${SERVICE}/server.ts ./${SERVICE}/server.ts
ENV NODE_ENV=production \
    SERVICE=${SERVICE}
USER node
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["sh", "-c", "exec node ${SERVICE}/server.ts"]
