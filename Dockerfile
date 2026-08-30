# Pinned to match the exact "playwright" npm version in package.json — the browser
# binaries baked into this image must match the driver version, or launches fail.
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

# Railway volumes mount here; also used for local runs via `docker run -v`.
RUN mkdir -p /data
ENV OUTPUT_DIR=/data

# NOTE: intentionally staying root here, not dropping to the image's `pwuser`.
# A Railway volume is mounted fresh at container start (root-owned, by default)
# regardless of what we chown in the image layer at build time — the earlier
# version of this Dockerfile did `USER pwuser` and every write to /data failed
# with EACCES once deployed. Chromium's own sandbox is already disabled via
# --no-sandbox in src/stealth.js (required for containers generally), so
# pwuser's actual purpose — letting Chromium's sandbox run unprivileged — isn't
# in play here; running as root in this single-purpose, single-tenant container
# is the simpler correct choice over a su/gosu entrypoint dance.
CMD ["node", "src/scraper.js"]
