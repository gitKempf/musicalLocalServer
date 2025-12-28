# Claude Agent - Session Runner

AI-powered code generation agent for Musical.run Local Server.

## Overview

This container runs Claude Code CLI and manages coding sessions. It provides a REST API for creating sessions, generating code, and managing the session lifecycle.

## Features

- **Session Management**: Create, list, and delete Claude coding sessions
- **Code Generation**: Execute AI-powered code generation via Claude Code CLI
- **Auto-Shutdown**: Automatically shuts down after 30 minutes of inactivity
- **Activity Tracking**: Monitors and logs session activity
- **Health Checks**: Built-in health monitoring endpoint
- **Graceful Shutdown**: Handles SIGTERM/SIGINT signals properly
- **Auto-Commit Hooks**: Automatically commits changes when Claude finishes inference

## Auto-Commit on Stop Feature

The claude-agent includes built-in hooks that automatically create git commits when Claude finishes working. This ensures all AI-generated changes are properly versioned.

### How It Works

```
User sends prompt to Claude
  ↓
Claude works on the code
  ├─ Creates/edits files
  ├─ Runs tests
  └─ Finishes responding
  ↓
🎯 STOP HOOK TRIGGERS
  ↓
Git commit created automatically
  ├─ Includes summary of changes
  ├─ Lists modified files
  └─ Pushes to Gitea (if configured)
```

### Hook Files

- `/root/.claude/hooks/commit-on-stop.sh` - Commits after each inference completion
- `/root/.claude/hooks/commit-on-session-end.sh` - Final commit when session ends
- `/root/.claude/settings.json` - Hook configuration

### Commit Message Format

```
🤖 Claude inference complete (550e8400)

Summary: Created authentication module with JWT tokens...

Changes:
src/auth.py
src/middleware.py
tests/test_auth.py

Statistics: 3 files changed, 145 insertions(+), 12 deletions(-)
Timestamp: 2025-12-26 12:00:00 UTC

Co-Authored-By: Claude <noreply@anthropic.com>
```

### Debugging Hooks

Hook logs are written to `/tmp/claude-hooks.log` inside the container:

```bash
docker exec musical-claude-agent-main cat /tmp/claude-hooks.log
```

## Architecture

```
┌─────────────────────────────────────┐
│   session-runner.js (Express)       │
│   - HTTP API Server (Port 17110)    │
│   - Session metadata management     │
│   - Activity tracking               │
└──────────────┬──────────────────────┘
               │
               ↓ spawn/manage
┌─────────────────────────────────────┐
│   Claude Code CLI Processes         │
│   - @anthropic-ai/claude-code       │
│   - Multiple concurrent sessions    │
└─────────────────────────────────────┘
```

## API Endpoints

### Health Check
```http
GET /health
```

**Response**:
```json
{
  "status": "healthy",
  "sessions": 2,
  "idleMinutes": 5,
  "autoShutdownMinutes": 30,
  "uptime": 3600
}
```

### Create Session
```http
POST /sessions/create
Content-Type: application/json

{
  "sessionId": "session_123",
  "projectId": "project_1",
  "workDir": "/app/projects/project_1"
}
```

**Response**:
```json
{
  "success": true,
  "session": {
    "id": "session_123",
    "projectId": "project_1",
    "status": "created",
    "createdAt": "2025-10-05T12:00:00.000Z"
  }
}
```

### Generate Code
```http
POST /sessions/:sessionId/generate
Content-Type: application/json

{
  "prompt": "Create a React button component",
  "options": {
    "timeout": 300000
  }
}
```

**Response**:
```json
{
  "success": true,
  "sessionId": "session_123",
  "output": "Here is your React button component...",
  "error": ""
}
```

### Get Session
```http
GET /sessions/:sessionId
```

**Response**:
```json
{
  "success": true,
  "session": {
    "id": "session_123",
    "projectId": "project_1",
    "status": "completed",
    "createdAt": "2025-10-05T12:00:00.000Z",
    "lastActivity": "2025-10-05T12:05:00.000Z",
    "outputLines": 42,
    "errorLines": 0
  }
}
```

### List Sessions
```http
GET /sessions
```

**Response**:
```json
{
  "success": true,
  "sessions": [
    {
      "id": "session_123",
      "projectId": "project_1",
      "status": "active",
      "createdAt": "2025-10-05T12:00:00.000Z",
      "lastActivity": "2025-10-05T12:05:00.000Z"
    }
  ],
  "count": 1
}
```

### Delete Session
```http
DELETE /sessions/:sessionId
```

**Response**:
```json
{
  "success": true,
  "message": "Session deleted"
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `17110` | HTTP server port |
| `ANTHROPIC_API_KEY` | Required | API key for Claude |
| `CLAUDE_AUTO_SHUTDOWN_MINUTES` | `30` | Idle timeout in minutes |

## File Structure

```
claude-agent/
├── Dockerfile              # Container image definition
├── package.json           # Node.js dependencies
├── session-runner.js      # Main Express server
├── auto-shutdown.sh       # Auto-shutdown script
└── README.md             # This file
```

## Session Storage

Sessions are stored in `/app/.claude-sessions/` with the following structure:

```
/app/.claude-sessions/
├── session_123/
│   ├── .claude/           # Claude session data
│   └── ...
└── session_456/
    ├── .claude/
    └── ...
```

## Auto-Shutdown

The container automatically shuts down after 30 minutes of inactivity to save resources.

**How it works**:
1. Activity tracking file: `/tmp/activity/last_activity`
2. Updated on every API request
3. `auto-shutdown.sh` checks every minute
4. If idle > threshold, sends SIGTERM to Claude processes
5. Container exits cleanly

**Configure timeout**:
```bash
docker run -e CLAUDE_AUTO_SHUTDOWN_MINUTES=60 ...
```

## Development

### Build
```bash
docker build -t musical-claude-agent .
```

### Run
```bash
docker run -p 17110:17110 \
  -e ANTHROPIC_API_KEY=your_key \
  -v claude_sessions:/app/.claude-sessions \
  -v projects:/app/projects \
  musical-claude-agent
```

### Test
```bash
# Health check
curl http://localhost:17110/health

# Create session
curl -X POST http://localhost:17110/sessions/create \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"test_1","projectId":"my_project"}'

# Generate code
curl -X POST http://localhost:17110/sessions/test_1/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Create a hello world function"}'
```

## Logs

The session runner logs all activity:

```
📝 Creating Claude session: session_123 for project: project_1
✅ Session created: session_123
🤖 Starting Claude Code generation for session: session_123
[Claude] Generating code...
✅ Generation completed for session: session_123
```

## Error Handling

The service handles several error scenarios:

1. **Session Not Found**: Returns 404
2. **Invalid Input**: Returns 400 with error message
3. **Claude CLI Failure**: Returns 500 with stderr output
4. **Network Issues**: Logged but doesn't crash server
5. **Process Crashes**: Gracefully handles and logs

## Security

- **API Key**: Never logged or exposed
- **Isolation**: Runs in dedicated container
- **No Internet**: Only connects to Anthropic API
- **File Access**: Limited to session and project volumes
- **Process Limits**: One Claude process per session

## Performance

- **Cold Start**: ~2-3 seconds (Claude CLI installation)
- **Session Creation**: ~100ms
- **Code Generation**: 5-30 seconds (varies by complexity)
- **Memory Usage**:
  - Idle: ~50MB
  - Active: ~200-500MB per session
- **Concurrent Sessions**: Tested up to 10 concurrent

## Troubleshooting

### Claude CLI not found
```bash
# Verify installation
docker exec <container_id> which claude
# Should return: /usr/local/bin/claude
```

### Out of memory
```bash
# Increase container memory limit
docker run --memory=2g ...
```

### Sessions not persisting
```bash
# Verify volume mount
docker inspect <container_id> | grep Mounts -A 10
```

### Auto-shutdown not working
```bash
# Check activity file
docker exec <container_id> cat /tmp/activity/last_activity

# Check auto-shutdown script
docker exec <container_id> ps aux | grep auto-shutdown
```

## License

MIT

## Support

For issues and questions, see the main Musical.run Local Server documentation.
