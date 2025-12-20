#!/bin/bash
#
# Musical.run Local Server - Claude Authentication Setup
#
# This script helps set up Claude Code CLI authentication for the local server.
#

set -e

echo "=================================================="
echo "  Musical.run Local Server - Authentication Setup"
echo "=================================================="
echo ""

# Check if Claude Code CLI is installed
if ! command -v claude &> /dev/null; then
    echo "❌ Claude Code CLI is not installed!"
    echo ""
    echo "Install it with:"
    echo "  npm install -g @anthropic-ai/claude-code"
    echo ""
    exit 1
fi

echo "✅ Claude Code CLI is installed"
echo ""

# Check if already authenticated
if [ -f "$HOME/.config/claude-code/auth.json" ]; then
    echo "⚠️  Authentication file already exists at:"
    echo "   $HOME/.config/claude-code/auth.json"
    echo ""
    read -p "Do you want to re-authenticate? (y/N): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Keeping existing authentication."
        echo ""
        echo "To test authentication, run:"
        echo "  claude --print 'Hello, test authentication'"
        echo ""
        exit 0
    fi
fi

echo "🔐 Starting Claude Code CLI authentication..."
echo ""
echo "IMPORTANT: This will open an interactive session."
echo "Once inside, type: /login"
echo ""
echo "You will see a URL like:"
echo "  https://claude.ai/oauth/authorize?code=true&client_id=..."
echo ""
echo "1. Copy that URL"
echo "2. Open it in your browser"
echo "3. Log in with your Claude.ai account (requires subscription)"
echo "4. Authorize the application"
echo "5. You'll be redirected to localhost (this is normal)"
echo "6. The CLI will automatically complete authentication"
echo ""
read -p "Press ENTER to start Claude CLI (or Ctrl+C to cancel)..."

# Start Claude CLI in interactive mode
# User will type /login inside the session
claude

# Check if authentication was successful
if [ -f "$HOME/.config/claude-code/auth.json" ]; then
    echo ""
    echo "✅ Authentication successful!"
    echo ""
    echo "Token saved to: $HOME/.config/claude-code/auth.json"
    echo ""
    echo "Testing authentication..."

    if claude --print "Hello, are you authenticated?" > /dev/null 2>&1; then
        echo "✅ Authentication test PASSED"
        echo ""
        echo "You can now start the Musical.run local server:"
        echo "  cd /root/musicalBackend/local-server"
        echo "  docker-compose up --build"
        echo ""
    else
        echo "⚠️  Authentication test failed"
        echo "Try running: claude --print 'test'"
        echo ""
    fi
else
    echo ""
    echo "❌ Authentication file not found"
    echo "Please try again or authenticate manually."
    echo ""
fi
