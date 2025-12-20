# Musical.run Local Server - Quick Start Guide

## One-Command Installation

Install and run the local server with a single command:

```bash
curl -fsSL https://musical.run/install.sh | bash
```

Or directly from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/gitKempf/musicalLocalServer/main/install.sh | bash
```

This will automatically:
- ✅ Check prerequisites (Docker, Git, etc.)
- ✅ Clone the repository
- ✅ Generate unique, secure credentials
- ✅ Start PostgreSQL, Gitea, and the Local Server
- ✅ Configure Gitea with admin user and API token
- ✅ Display connection information

### Custom Installation Options

```bash
# Install to a custom directory
curl -fsSL https://musical.run/install.sh | bash -s -- --dir /custom/path

# Use custom ports
curl -fsSL https://musical.run/install.sh | bash -s -- --port 8100 --gitea-port 8101
```

---

## Manual Installation (Alternative)

### Prerequisites

1. **Docker & Docker Compose** installed
2. **Claude.ai Subscription** (required for Claude Code CLI)
3. **Node.js 20+** (for running on host)

### Step 1: Authenticate Claude Code CLI

Claude Code uses web-based OAuth authentication, not API keys.

### Install Claude Code CLI (if not installed)
```bash
npm install -g @anthropic-ai/claude-code
```

### Run Authentication
```bash
claude setup-token
```

**What happens**:
1. Browser opens to: `https://claude.ai/auth/token`
2. You log in with your Claude account
3. Token is saved to `~/.config/claude-code/auth.json`

### Verify Authentication
```bash
claude --print "Hello, test authentication"
```

If you see a response from Claude, authentication is working!

## Step 2: Start Local Server

```bash
cd local-server
docker-compose up --build -d
```

**What starts**:
- Main local server (port **17100**)
- Claude agent (port **17110**)
- PostgreSQL database (port **17102**)
- Gitea (port **17101**)

> **Note**: Gitea is automatically configured on first startup. No manual setup required!

### Step 4: Test the Server

### Health Check
```bash
curl http://localhost:17100/health
```

**Expected response**:
```json
{
  "status": "healthy",
  "version": "1.0.0",
  "uptime": 42,
  "publicKey": "base64_encoded_public_key...",
  "cloudConnected": false
}
```

### Claude Agent Health Check
```bash
curl http://localhost:17110/health
```

**Expected response**:
```json
{
  "status": "healthy",
  "sessions": 0,
  "idleMinutes": 0,
  "autoShutdownMinutes": 30,
  "uptime": 42
}
```

## Step 4: Test Code Generation

### Create a Session
```bash
curl -X POST http://localhost:17100/api/sessions/create \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "test-project-1",
    "workDir": "/app/projects/test-project-1"
  }'
```

**Response**:
```json
{
  "success": true,
  "sessionId": "session_1728123456789_abc123xyz",
  "projectId": "test-project-1",
  "status": "created",
  "createdAt": "2025-10-05T12:00:00.000Z"
}
```

### Send a Prompt (Without Encryption - for testing)

First, let's test the Claude agent directly:

```bash
SESSION_ID="session_1728123456789_abc123xyz"

curl -X POST "http://localhost:17110/sessions/$SESSION_ID/generate" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Create a simple hello world function in JavaScript"
  }'
```

**Response** (may take 5-30 seconds):
```json
{
  "success": true,
  "sessionId": "session_1728123456789_abc123xyz",
  "output": "Here is a hello world function:\n\nfunction helloWorld() {\n  console.log('Hello, World!');\n}\n\nexport { helloWorld };"
}
```

## Step 5: Test Encrypted Communication (Full Privacy Mode)

To test the complete encrypted flow, you need to:

1. **Get server's public key**:
```bash
curl http://localhost:17100/health | jq -r '.publicKey'
```

2. **Encrypt your prompt** (requires libsodium in browser/script)

3. **Send encrypted message**:
```bash
curl -X POST "http://localhost:17100/api/sessions/$SESSION_ID/message" \
  -H "Content-Type: application/json" \
  -d '{
    "encryptedMessage": "base64_encrypted_prompt",
    "senderPublicKey": "your_public_key"
  }'
```

4. **Decrypt response** using your private key

## Architecture Overview

```
┌──────────────────────────────────────────────────┐
│  Your Browser (Port: Your choice)                │
│  - Encrypts prompts with libsodium               │
│  - Decrypts responses                            │
└────────────────┬─────────────────────────────────┘
                 │ HTTPS (Encrypted)
                 ↓
┌──────────────────────────────────────────────────┐
│  Local Server (Port 17100)                       │
│  - EncryptionService (decrypt/encrypt)           │
│  - ClaudeSessionManager                          │
│  - Session Routes                                │
└────────────────┬─────────────────────────────────┘
                 │ HTTP (Internal Docker network)
                 ↓
┌──────────────────────────────────────────────────┐
│  Claude Agent (Port 17110)                       │
│  - session-runner.js (Express API)               │
│  - Spawns Claude Code CLI processes              │
│  - Auth from: ~/.config/claude-code/             │
└────────────────┬─────────────────────────────────┘
                 │
                 ↓
           Anthropic API (Claude)
```

## Accessing the Server

### Local Access
- Main Server: `http://localhost:17100`
- Claude Agent: `http://localhost:17110` (internal)
- Gitea: `http://localhost:17101`
- PostgreSQL: `localhost:17102`

### Remote Access (Optional)

If you want to access from another machine:

1. **Use Cloudflare Tunnel** (recommended):
```bash
# Set tunnel token in .env
TUNNEL_TOKEN=your_cloudflare_tunnel_token

# Start with tunnel
docker-compose --profile with-tunnel up
```

2. **Direct IP** (not recommended - no encryption):
```bash
# Access via your machine's IP
http://YOUR_IP:17100
```

## Authentication URL

**For web-based login setup**:

The `claude setup-token` command will provide you with a URL like:
```
https://claude.ai/auth/token?return_url=...
```

**Log in at**: https://claude.ai/auth/token

After logging in, the token will be automatically saved to your machine.

## Troubleshooting

### "Claude not authenticated" error

```bash
# Check if token exists
ls -la ~/.config/claude-code/auth.json

# If missing, run setup again
claude setup-token
```

### Container can't find authentication

```bash
# Verify volume mount
docker inspect musical-claude-agent | grep -A 5 "Mounts"

# Should show:
# Source: /root/.config/claude-code
# Destination: /root/.config/claude-code
```

### Port already in use

```bash
# Check what's using the port
sudo lsof -i :17100

# Stop existing server
docker-compose down
```

### Claude agent not starting

```bash
# Check logs
docker logs musical-claude-agent

# Common issues:
# - Authentication not configured
# - Port 17110 already in use
# - Node.js not installed in container
```

## Production Deployment

For production use:

1. **Use HTTPS**: Set up reverse proxy (Nginx/Traefik)
2. **Enable Cloudflare Tunnel**: For secure remote access
3. **Configure Auto-updates**: Set up watchtower
4. **Backup Sessions**: Backup `musical_claude_sessions` volume
5. **Monitor Logs**: Use logging service (e.g., Loki)

## Next Steps

1. **Build Frontend**: Create Next.js web app for encrypted UI
2. **Deploy to Cloud**: Use gVisor for production security
3. **Add WebSocket**: For real-time progress streaming
4. **Implement Marketplace**: For project templates

## Support

- GitHub Issues: https://github.com/musical/local-server/issues
- Documentation: https://docs.musical.run
- Discord: https://discord.gg/musical

---

**Security Note**: Always use encryption in production. The unencrypted API endpoints are for testing only.
