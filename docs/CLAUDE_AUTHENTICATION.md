# Claude Code CLI Authentication Guide - CORRECTED

## Overview

Claude Code CLI uses **web-based OAuth 2.0 authentication** with PKCE (Proof Key for Code Exchange), NOT API keys.

## Authentication Flow

### Step-by-Step Process

1. **Start Claude CLI in interactive mode**:
```bash
claude
```

2. **Type `/login` inside the CLI**:
```
> /login
```

3. **Copy the OAuth URL** that appears (example):
```
https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&scope=user:inference+user:profile&code_challenge=XMXuTFf1o_4NjkbJs5TjSWobIYCaRJZulw6eOCrZR-0&code_challenge_method=S256&state=McHqnIBDmw0HPAbEm5Q7FRUVCZQ-3czd4eYIKOESnXA&redirect_uri=http://localhost:38833/callback
```

4. **Open the URL in your browser**

5. **Log in** with your Claude.ai account (requires Pro/Team subscription)

6. **Authorize** the Claude Code CLI application

7. **Browser redirects** to `http://localhost:38833/callback` (CLI is listening on this port)

8. **Authentication complete!** Token is saved to `~/.config/claude-code/auth.json`

## OAuth URL Parameters Explained

```
https://claude.ai/oauth/authorize?
  code=true                              # Request authorization code
  &client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e  # Claude Code CLI client ID
  &response_type=code                    # OAuth 2.0 authorization code flow
  &scope=user:inference+user:profile     # Permissions requested
  &code_challenge=<random_base64>        # PKCE challenge (SHA-256 hash)
  &code_challenge_method=S256            # PKCE method
  &state=<random_string>                 # CSRF protection
  &redirect_uri=http://localhost:38833/callback  # Where browser redirects after auth
```

**Security Features**:
- **PKCE**: Protects against authorization code interception
- **State parameter**: Prevents CSRF attacks
- **Localhost redirect**: Token never leaves your machine
- **Scopes**: Limited to inference and profile access only

## Alternative: setup-token Command

For users with Claude subscription, there's also:
```bash
claude setup-token
```

This provides a simpler flow but requires an active subscription and may have different token permissions.

## Token Storage

After successful authentication, the token is stored in:
```
~/.config/claude-code/auth.json
```

**File format**:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresAt": "2025-12-31T23:59:59.000Z",
  "refreshToken": "optional_refresh_token"
}
```

**Permissions**: Should be `600` (read/write owner only)
```bash
chmod 600 ~/.config/claude-code/auth.json
```

## Local Server Implementation

Our `claude-agent` container mounts the authentication config:

```yaml
claude-agent:
  volumes:
    - ~/.config/claude-code:/root/.config/claude-code:ro  # Read-only mount
```

**How it works**:
1. You authenticate on **host machine** using interactive CLI
2. Token saved to `~/.config/claude-code/auth.json`
3. Docker container **mounts this directory** as read-only
4. Claude Code CLI inside container reads the token
5. **No token in environment variables or logs**

## Setup Script

We provide a helper script:
```bash
cd /root/musicalBackend/local-server
./scripts/setup-auth.sh
```

This script:
- Checks if Claude CLI is installed
- Starts interactive session for you
- Prompts you to type `/login`
- Verifies authentication after completion

## Manual Authentication (If Script Fails)

### For Interactive Terminal

```bash
# 1. Start Claude CLI
claude

# 2. Inside the CLI, type:
> /login

# 3. Copy the URL that appears
# 4. Open in browser
# 5. Log in and authorize
# 6. CLI will automatically complete
```

### For Non-Interactive Environment

If you're on a server without display:

```bash
# 1. On your LOCAL machine (with browser):
claude
> /login
# Copy the OAuth URL

# 2. Open URL in browser, complete authentication

# 3. Copy the entire ~/.config/claude-code/ directory to server:
scp -r ~/.config/claude-code/ user@server:~/.config/

# 4. On server, verify:
claude --print "test authentication"
```

## Docker Compose Configuration

### Updated docker-compose.yml

```yaml
services:
  claude-agent:
    build:
      context: ./claude-agent
      dockerfile: Dockerfile
    environment:
      - PORT=17110
      # NO API KEY NEEDED!
    volumes:
      - musical_claude_sessions:/app/.claude-sessions
      - musical_projects:/app/projects
      # Mount authentication from host
      - ${HOME}/.config/claude-code:/root/.config/claude-code:ro
    networks:
      - musical-local
```

**Key points**:
- No `ANTHROPIC_API_KEY` environment variable
- Authentication file mounted as **read-only** (`:ro`)
- Uses `${HOME}` to work on any system

## Verification

### Test Authentication Works

```bash
# Quick test
claude --print "Hello, are you authenticated?"

# Should return a response from Claude (not an error)
```

### Check Token File Exists

```bash
ls -la ~/.config/claude-code/auth.json

# Should show:
# -rw------- 1 user user 1234 Oct 5 12:00 /home/user/.config/claude-code/auth.json
```

### Test in Container

```bash
# Start the stack
docker-compose up -d

# Check container can authenticate
docker exec musical-claude-agent claude --print "test"

# Should return Claude's response (proves auth works in container)
```

## Troubleshooting

### Error: "Not authenticated"

**Solution 1**: Re-run authentication
```bash
claude
> /login
# Follow the URL and complete auth
```

**Solution 2**: Check file exists
```bash
cat ~/.config/claude-code/auth.json
# Should show a JSON object with "token" field
```

**Solution 3**: Check permissions
```bash
chmod 600 ~/.config/claude-code/auth.json
```

### Error: "Cannot open browser"

If you're on a headless server:
```bash
# CLI will show the OAuth URL in terminal
# Manually copy it and open in browser on another machine
```

### Container can't find authentication

**Check volume mount**:
```bash
docker inspect musical-claude-agent | grep -A 10 Mounts

# Should show:
# "Source": "/root/.config/claude-code",
# "Destination": "/root/.config/claude-code",
# "RW": false
```

**Fix**: Make sure file exists on host BEFORE starting container
```bash
ls ~/.config/claude-code/auth.json
# If missing, run authentication first
```

### OAuth redirect fails

If `http://localhost:38833/callback` doesn't work:

1. **Firewall**: Ensure port 38833 is not blocked
2. **Localhost access**: Ensure you can access localhost
3. **Browser**: Try a different browser
4. **CLI version**: Update Claude Code CLI
   ```bash
   npm update -g @anthropic-ai/claude-code
   ```

## Security Best Practices

### Token Protection
- **Never commit** `auth.json` to git
- **Never log** token values
- **Never share** token with others
- **Rotate** token if compromised

### Container Security
- Mount authentication as **read-only** (`:ro`)
- Use minimal container permissions
- Don't expose authentication ports externally
- Keep token file permissions at `600`

### Token Revocation

To revoke a token:
1. Visit Claude.ai account settings
2. Go to "API & Integrations"
3. Find "Claude Code CLI" session
4. Click "Revoke"

Or simply delete the file:
```bash
rm ~/.config/claude-code/auth.json
# Re-authenticate when needed
```

## For Development/Testing

### Mock Authentication (Testing Only)

For testing container setup WITHOUT real authentication:

```bash
mkdir -p ~/.config/claude-code
cat > ~/.config/claude-code/auth.json << 'EOF'
{
  "token": "mock-token-for-testing-only",
  "expiresAt": "2099-12-31T23:59:59.000Z"
}
EOF
chmod 600 ~/.config/claude-code/auth.json
```

**Note**: This won't work for actual code generation, only for testing volume mounts.

## OAuth Flow Diagram

```
┌─────────────────────────────────────────────┐
│  1. User runs: claude                       │
│     User types: /login                      │
└──────────────┬──────────────────────────────┘
               │
               ↓ CLI generates PKCE challenge
┌─────────────────────────────────────────────┐
│  2. CLI shows OAuth URL with:               │
│     - client_id (Claude Code CLI)           │
│     - code_challenge (PKCE)                 │
│     - redirect_uri (localhost:38833)        │
└──────────────┬──────────────────────────────┘
               │
               ↓ User copies URL to browser
┌─────────────────────────────────────────────┐
│  3. Browser: https://claude.ai/oauth/...    │
│     User logs in with Claude account        │
│     User clicks "Authorize"                 │
└──────────────┬──────────────────────────────┘
               │
               ↓ Redirect with auth code
┌─────────────────────────────────────────────┐
│  4. Browser: http://localhost:38833/callback│
│     URL contains: ?code=<auth_code>         │
│     CLI is listening on port 38833          │
└──────────────┬──────────────────────────────┘
               │
               ↓ CLI exchanges code for token
┌─────────────────────────────────────────────┐
│  5. CLI sends:                              │
│     - auth_code                             │
│     - code_verifier (PKCE proof)            │
│     Receives: access_token                  │
└──────────────┬──────────────────────────────┘
               │
               ↓ Save token
┌─────────────────────────────────────────────┐
│  6. Token saved to:                         │
│     ~/.config/claude-code/auth.json         │
│     ✅ Authentication complete!             │
└─────────────────────────────────────────────┘
```

## Quick Reference

**Authenticate**:
```bash
claude
> /login
```

**Test**:
```bash
claude --print "test"
```

**Token location**:
```
~/.config/claude-code/auth.json
```

**Docker mount**:
```yaml
- ${HOME}/.config/claude-code:/root/.config/claude-code:ro
```

**Revoke**:
```bash
rm ~/.config/claude-code/auth.json
```

---

**Ready to authenticate?** Run: `./scripts/setup-auth.sh`
