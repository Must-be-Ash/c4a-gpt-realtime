# Coinbase for Agents — hosted web + phone deployment (Fly.io).
FROM node:22-bookworm-slim

WORKDIR /app

# Install all deps (incl. esbuild devDep needed for the build step).
COPY package.json package-lock.json ./
RUN npm ci

# App source + build the browser/dashboard bundles.
COPY . .
RUN npm run build

# Run as a non-root user with a writable home (AgentCash wallet lives in ~/.agentcash).
RUN useradd -m -u 10001 appuser \
 && mkdir -p /app/runtime /app/reports \
 && chown -R appuser:appuser /app
USER appuser
ENV NODE_ENV=production HOME=/home/appuser

EXPOSE 4173
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
