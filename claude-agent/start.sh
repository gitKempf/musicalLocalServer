#!/bin/bash
# Startup script for Claude agent container
# Starts both SSH server and session runner

set -e

echo "🚀 Starting Claude Agent Container..."

# Start SSH server
echo "🔐 Starting SSH server..."
/usr/sbin/sshd

# Check if SSH is running
if pgrep -x sshd > /dev/null; then
    echo "✅ SSH server started successfully"
else
    echo "❌ Failed to start SSH server"
    exit 1
fi

# Start session runner
echo "🤖 Starting Claude session runner..."
exec node /app/session-runner.js
