# Production image: standalone Next.js build, non-root runtime.
#   docker build -f dockerfiles/prod.dockerfile -t northwind-refunds-agent .
#   docker run -p 3000:3000 -e ANTHROPIC_API_KEY=... -e DEMO_ADMIN_TOKEN=... northwind-refunds-agent

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
# The mock CRM + policy doc are read from disk at runtime (lib/store.ts).
COPY --from=builder --chown=node:node /app/data ./data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
