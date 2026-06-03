# WHISPERS Warden — always-on worker (privileged SpacetimeDB client + Claude).
FROM node:22-slim
WORKDIR /app

# install deps (include dev: tsx runs the TypeScript at runtime)
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# app source (module_bindings, warden.ts, world.ts). .env is NEVER copied —
# the ANTHROPIC_API_KEY is injected as a Fly secret at runtime.
COPY . .

# no inbound port — outbound-only worker
CMD ["npm", "start"]
