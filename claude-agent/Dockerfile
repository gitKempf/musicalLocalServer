# Claude Agent Container - Runs Claude Code CLI
# Isolated container for AI code generation with auto-shutdown

FROM node:20-bullseye

# Install system dependencies including SSH server
RUN apt-get update && apt-get install -y \
    curl \
    git \
    vim \
    procps \
    openssh-server \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Configure SSH
RUN mkdir -p /var/run/sshd && \
    echo 'root:musical' | chpasswd && \
    sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config && \
    sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config && \
    sed 's@session\s*required\s*pam_loginuid.so@session optional pam_loginuid.so@g' -i /etc/pam.d/sshd

# Create app directory
WORKDIR /app

# Install Claude Code CLI and MCP SDK globally
RUN npm install -g @anthropic-ai/claude-code @modelcontextprotocol/sdk

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Create directories
RUN mkdir -p /app/.claude-sessions \
    /app/projects \
    /tmp/activity

# Copy auto-shutdown script
COPY auto-shutdown.sh /usr/local/bin/auto-shutdown.sh
RUN chmod +x /usr/local/bin/auto-shutdown.sh

# Copy session manager
COPY session-runner.js /app/session-runner.js

# Copy MCP server
COPY mcp-server-git.js /app/mcp-server-git.js
RUN chmod +x /app/mcp-server-git.js

# Copy Claude Code configuration
COPY claude-config.json /root/.config/claude-code/config.json
RUN mkdir -p /root/.config/claude-code

# Configure Git
RUN git config --global user.name "Claude Code" && \
    git config --global user.email "claude@musical.run"

# Environment variables
ENV NODE_ENV=production
ENV CLAUDE_AUTO_SHUTDOWN_MINUTES=30

# Expose ports
EXPOSE 17110 22

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD pgrep -f "node.*session-runner" > /dev/null || exit 1

# Create startup script
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

# Start SSH server and session runner
CMD ["/usr/local/bin/start.sh"]
