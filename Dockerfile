# Glama.ai listing check: start the MCP server and answer introspection.
# Production runs on Cloudflare Workers (mcp.ko.io); this container runs the
# same worker locally via wrangler's miniflare runtime — no CF account, no
# secrets (KO_API_URL defaults to the public https://api.ko.io).
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY . .

ENV WRANGLER_SEND_METRICS=false
EXPOSE 8080

# MCP endpoint: http://localhost:8080/mcp (Streamable HTTP JSON-RPC)
CMD ["npx", "wrangler", "dev", "--local", "--ip", "0.0.0.0", "--port", "8080"]
