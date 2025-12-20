# Claude Code CLI Authentication - Quick Start

## 🔐 **Authentication URL**

To authenticate Claude Code CLI for the Musical.run local server, follow these steps:

### **Option 1: Interactive Authentication (Recommended)**

```bash
# Start Claude CLI
claude

# Inside the CLI, type:
/login
```

The CLI will display an OAuth URL like this:
```
https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&scope=user:inference+user:profile&code_challenge=XMXuTFf1o_4NjkbJs5TjSWobIYCaRJZulw6eOCrZR-0&code_challenge_method=S256&state=McHqnIBDmw0HPAbEm5Q7FRUVCZQ-3czd4eYIKOESnXA&redirect_uri=http://localhost:38833/callback
```

**Then**:
1. **Copy the URL**
2. **Open in your browser**
3. **Log in** with your Claude.ai account (requires Pro/Team subscription)
4. **Click "Authorize"**
5. Browser redirects to `http://localhost:38833/callback` (CLI captures this)
6. **Done!** Token saved to `~/.config/claude-code/auth.json`

### **Option 2: Using Helper Script**

```bash
cd /root/musicalBackend/local-server
./scripts/setup-auth.sh
```

This script guides you through the process.

### **Option 3: Manual Token Setup (If you already have a token)**

If you authenticated on another machine:

```bash
# Create config directory
mkdir -p ~/.config/claude-code

# Copy auth.json from another machine
# Or manually create it:
cat > ~/.config/claude-code/auth.json << 'EOF'
{
  "token": "YOUR_TOKEN_HERE"
}
EOF

# Set permissions
chmod 600 ~/.config/claude-code/auth.json
```

## ✅ **Verify Authentication**

```bash
# Test that Claude is authenticated
claude --print "Hello, are you working?"
```

**Expected output**: Claude's response (not an error)

## 🚀 **Start Local Server**

Once authenticated:

```bash
cd /root/musicalBackend/local-server

# Build and start all services
docker-compose up --build

# Or in detached mode:
docker-compose up --build -d
```

## 🧪 **Test the Setup**

### 1. Check Health
```bash
curl http://localhost:17100/health
curl http://localhost:17110/health
```

### 2. Create a Session
```bash
curl -X POST http://localhost:17100/api/sessions/create \
  -H "Content-Type: application/json" \
  -d '{"projectId": "test-project-1"}'
```

**Save the `sessionId` from the response!**

### 3. Generate Code
```bash
# Replace SESSION_ID with the one from step 2
curl -X POST http://localhost:17110/sessions/SESSION_ID/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Create a simple hello world function in JavaScript"}'
```

**Expected**: Claude generates JavaScript code (takes 5-30 seconds)

## 📝 **Important Notes**

1. **Subscription Required**: Claude Code CLI requires a Claude Pro or Team subscription
2. **Token Location**: `~/.config/claude-code/auth.json`
3. **Container Access**: Token is mounted read-only into the container
4. **No API Keys**: We don't use `ANTHROPIC_API_KEY` - only OAuth tokens
5. **Port 38833**: The CLI listens on this port during authentication (temporary)

## 🔧 **Troubleshooting**

### "Not authenticated" error
```bash
# Re-run authentication
claude
> /login
```

### Token file doesn't exist
```bash
# Check location
ls -la ~/.config/claude-code/auth.json

# If missing, authenticate first
```

### Container can't find token
```bash
# Verify volume mount
docker inspect musical-claude-agent | grep -A 5 Mounts

# Restart container after creating token
docker-compose restart claude-agent
```

## 🔗 **Quick Links**

- **Full Authentication Guide**: [CLAUDE_AUTHENTICATION.md](./CLAUDE_AUTHENTICATION.md)
- **Manual Test Results**: [MANUAL_TEST_RESULTS.md](./MANUAL_TEST_RESULTS.md)
- **Quick Start Guide**: [../QUICKSTART.md](../QUICKSTART.md)

---

**Ready?** Start with: `claude` then type `/login` inside the CLI!
