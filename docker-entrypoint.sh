#!/bin/sh
# Docker entrypoint for Musical.run Local Server
# Ensures proper startup and logging

set -e

echo "🚀 Starting Musical.run Local Server..."
echo "📅 Date: $(date)"
echo "🔧 Node version: $(node --version)"
echo "📂 Working directory: $(pwd)"
echo ""

# Start the server
exec node dist/server.js
