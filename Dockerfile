# syntax=docker/dockerfile:1
# badgR: policy tiers for R scripts, Shiny apps, and projects, checked with flowR.
# The image carries the full flowR signature database (base R and all of CRAN), so it works offline.

FROM node:24-bookworm AS builder
WORKDIR /app
# tree-sitter-r builds a native module
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY policies ./policies
RUN npx tsc -p tsconfig.json && npm prune --omit=dev
# fetch the signature-database shards flowR's link file names, verified by their sha256
ENV XDG_CACHE_HOME=/opt/cache
RUN node dist/cli.js --sigdb-download

FROM node:24-bookworm-slim
LABEL org.opencontainers.image.title="badgR" \
      org.opencontainers.image.description="Policy tiers (gold, silver, bronze) for R code, checked with flowR" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"
WORKDIR /app
ENV XDG_CACHE_HOME=/opt/cache NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /opt/cache /opt/cache
# flowR decompresses shards into the cache on first use, whichever user runs the container
RUN chmod -R a+rwX /opt/cache
COPY package.json ./
COPY policies ./policies
# the analyzed code is mounted at /work, read-only
WORKDIR /work
USER node
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--help"]
