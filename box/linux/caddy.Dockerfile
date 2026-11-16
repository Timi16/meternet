# The box's front door: Caddy with the portal pages built in (web/, the same
# browser wallet as the public Meter). Build context: the repository root.
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN node build.mjs

FROM caddy:2.10.0
COPY --from=web /web/public /srv/web
COPY box/linux/Caddyfile /etc/caddy/Caddyfile
