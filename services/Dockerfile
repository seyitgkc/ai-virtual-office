# syntax=docker/dockerfile:1

# One image definition for both stand-in services. SERVICE picks which one.
# Each is a single file with no dependencies, run directly by Node.
FROM node:26-alpine
ARG SERVICE
WORKDIR /app
COPY ${SERVICE}/server.ts ./server.ts
ENV NODE_ENV=production
USER node
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["node", "server.ts"]
