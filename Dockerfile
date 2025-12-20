# Musical.run Local Server - Docker Image
FROM node:20-bullseye-slim

# Install dependencies including cloudflared
RUN apt-get update && apt-get install -y \
    curl \
    git \
    qrencode \
    wget \
    && wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb \
    && dpkg -i cloudflared-linux-amd64.deb \
    && rm cloudflared-linux-amd64.deb \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally via npm
RUN npm install -g @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install ALL dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY src/ ./src/

# Copy public directory (terminal.html, etc.)
COPY public/ ./public/

# Build TypeScript
RUN npm run build

# Remove devDependencies after build
RUN npm prune --production

# Create directories for runtime
RUN mkdir -p /root/.musical/{data,keys,logs,config}

# Copy entrypoint script
COPY docker-entrypoint.sh /app/
RUN chmod +x /app/docker-entrypoint.sh

# Expose port
EXPOSE 17100

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:17100/health || exit 1

# Start server
CMD ["/app/docker-entrypoint.sh"]
