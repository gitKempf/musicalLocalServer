# Git Auto-Commit on Claude Code Inference Completion - Stop Hook Solution

## Overview

This solution automatically creates a git commit when Claude Code finishes its inference and returns control to you. It uses the **Stop Hook** which triggers exactly when Claude completes responding.

**Result:** One clean commit per complete inference cycle, NOT per file change.

---

## How It Works

```
User: "Create a FastAPI application with authentication"
  ↓
Claude starts working
  ├─ Creates files
  ├─ Edits code  
  ├─ Runs tests
  └─ Writes documentation
  ↓
Claude finishes: "I've created the application..."
  ↓
🎯 STOP HOOK TRIGGERS AUTOMATICALLY
  ↓
Git commit created: "🤖 Claude inference complete"
  ├─ Includes all changes from this inference
  ├─ Adds descriptive commit message
  └─ Pushes to Gitea (if configured)
  ↓
User sees prompt, ready for next command
```

---

## Installation Steps

### Step 1: Create the Hook Script

Create file: `~/.claude/hooks/commit-on-stop.sh`

```bash
#!/bin/bash
################################################################################
# Stop Hook - Commit when Claude finishes inference
#
# Triggers: When Claude Code finishes responding (not on user interrupt)
# Purpose: Create a git commit after each complete inference series
################################################################################

# Read JSON input from stdin
INPUT=$(cat)

# Parse JSON fields
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // ""')
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // "false"')

# Change to working directory
cd "$CWD" || exit 0

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo "Not a git repository, skipping commit"
    exit 0
fi

# CRITICAL: Prevent infinite loop
# If stop_hook_active is true, it means we're already in a continuation
# triggered by a previous Stop hook. Don't commit again.
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
    echo "Stop hook already active, skipping commit to prevent loop"
    exit 0
fi

# Check if there are changes to commit
if git diff-index --quiet HEAD -- 2>/dev/null; then
    echo "No changes to commit"
    exit 0
fi

# Get the last assistant message from transcript (optional - for better commit message)
LAST_MESSAGE=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
    # Extract last assistant message (optional, requires jq)
    LAST_MESSAGE=$(tail -20 "$TRANSCRIPT_PATH" | jq -r 'select(.role == "assistant") | .content[0].text // ""' 2>/dev/null | tail -1 | head -c 200)
fi

# Create timestamp
TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M:%S UTC")

# Get statistics about changes
STATS=$(git diff --stat HEAD 2>/dev/null | tail -1)
MODIFIED_FILES=$(git diff --name-only HEAD 2>/dev/null | head -10)

# Build commit message
if [ -n "$LAST_MESSAGE" ]; then
    COMMIT_MSG="🤖 Claude inference complete (Session: ${SESSION_ID:0:8})

Summary: ${LAST_MESSAGE}

Changes:
${MODIFIED_FILES}

Statistics: ${STATS}
Timestamp: ${TIMESTAMP}

Co-Authored-By: Claude <noreply@anthropic.com>"
else
    COMMIT_MSG="🤖 Claude inference complete (Session: ${SESSION_ID:0:8})

Modified files:
${MODIFIED_FILES}

Statistics: ${STATS}
Timestamp: ${TIMESTAMP}

Co-Authored-By: Claude <noreply@anthropic.com>"
fi

# Stage all changes
git add -A

# Commit
if git commit -m "$COMMIT_MSG" 2>/dev/null; then
    echo "✅ Auto-commit created after Claude inference completion"
    
    # Try to push (non-blocking)
    if git push origin "$(git branch --show-current)" 2>/dev/null; then
        echo "✅ Pushed to Gitea"
    else
        echo "⚠️  Could not push to remote (this is OK)"
    fi
else
    echo "⚠️  Commit failed (possibly nothing to commit)"
fi

exit 0
```

**Make it executable:**

```bash
chmod +x ~/.claude/hooks/commit-on-stop.sh
```

---

### Step 2: Create Backup Hook (SessionEnd - Optional but Recommended)

Create file: `~/.claude/hooks/commit-on-session-end.sh`

```bash
#!/bin/bash
################################################################################
# SessionEnd Hook - Final commit when session ends
#
# Triggers: When Claude Code session ends (exit/close)
# Purpose: Backup commit to catch any uncommitted work
################################################################################

# Read JSON input from stdin
INPUT=$(cat)

# Parse JSON fields
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // ""')
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
REASON=$(echo "$INPUT" | jq -r '.reason // "unknown"')

# Change to working directory
cd "$CWD" || exit 0

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo "Not a git repository, skipping session end commit"
    exit 0
fi

# Check if there are changes to commit
if git diff-index --quiet HEAD -- 2>/dev/null; then
    echo "No uncommitted changes at session end"
    exit 0
fi

# Create timestamp
TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M:%S UTC")

# Get session statistics
STATS=$(git diff --stat HEAD 2>/dev/null | tail -1)
MODIFIED_FILES=$(git diff --name-only HEAD 2>/dev/null)

# Build commit message
COMMIT_MSG="🤖 Claude session ended (ID: ${SESSION_ID:0:8})

Final commit for session that ended: ${REASON}

Modified files:
${MODIFIED_FILES}

Statistics: ${STATS}
Timestamp: ${TIMESTAMP}

Co-Authored-By: Claude <noreply@anthropic.com>"

# Stage and commit
git add -A

if git commit -m "$COMMIT_MSG" 2>/dev/null; then
    echo "✅ Final session commit created"
    
    # Try to push
    if git push origin "$(git branch --show-current)" 2>/dev/null; then
        echo "✅ Pushed to Gitea"
    else
        echo "⚠️  Could not push to remote (this is OK)"
    fi
else
    echo "⚠️  No changes to commit at session end"
fi

exit 0
```

**Make it executable:**

```bash
chmod +x ~/.claude/hooks/commit-on-session-end.sh
```

---

### Step 3: Configure Claude Code Settings

**Option A: User-level (applies to all projects)**

Edit or create: `~/.claude/settings.json`

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/commit-on-stop.sh"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/commit-on-session-end.sh"
          }
        ]
      }
    ]
  }
}
```

**Option B: Project-level (specific project only)**

Edit or create: `.claude/settings.json` in your project directory

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/commit-on-stop.sh"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/commit-on-session-end.sh"
          }
        ]
      }
    ]
  }
}
```

**Option C: Using the /hooks command in Claude Code**

```bash
# Start Claude Code
claude

# Use the interactive hook configurator
> /hooks

# Select "Stop" hook
# Add command: bash ~/.claude/hooks/commit-on-stop.sh
# Repeat for "SessionEnd" hook
```

---

### Step 4: Set Up Git Remote (for auto-push to Gitea)

If you want automatic push to Gitea, configure git remote with token authentication:

```bash
# Navigate to your project
cd /workspace

# Initialize git if not already done
git init

# Add Gitea remote with token authentication
git remote add origin http://YOUR_GITEA_TOKEN@gitea:3000/username/repository.git

# Or for external Gitea
git remote add origin http://YOUR_GITEA_TOKEN@gitea.example.com/username/repository.git

# Test the connection
git push -u origin main
```

**Alternative: Use SSH instead**

```bash
git remote add origin ssh://git@gitea:22/username/repository.git
```

---

## Complete Installation Script

Here's a single script to automate everything:

```bash
#!/bin/bash
# Install Stop Hook for Claude Code

set -e

echo "======================================================"
echo "  Installing Claude Code Stop Hook for Auto-Commit"
echo "======================================================"
echo ""

# Create hooks directory
mkdir -p ~/.claude/hooks

# Create commit-on-stop.sh
cat > ~/.claude/hooks/commit-on-stop.sh <<'EOF'
#!/bin/bash
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // ""')
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // "false"')

cd "$CWD" || exit 0

if ! git rev-parse --git-dir > /dev/null 2>&1; then
    exit 0
fi

if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
    exit 0
fi

if git diff-index --quiet HEAD -- 2>/dev/null; then
    exit 0
fi

LAST_MESSAGE=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
    LAST_MESSAGE=$(tail -20 "$TRANSCRIPT_PATH" | jq -r 'select(.role == "assistant") | .content[0].text // ""' 2>/dev/null | tail -1 | head -c 200)
fi

TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M:%S UTC")
STATS=$(git diff --stat HEAD 2>/dev/null | tail -1)
MODIFIED_FILES=$(git diff --name-only HEAD 2>/dev/null | head -10)

if [ -n "$LAST_MESSAGE" ]; then
    COMMIT_MSG="🤖 Claude inference complete (${SESSION_ID:0:8})

Summary: ${LAST_MESSAGE}

Changes: ${STATS}
Timestamp: ${TIMESTAMP}

Co-Authored-By: Claude <noreply@anthropic.com>"
else
    COMMIT_MSG="🤖 Claude inference complete (${SESSION_ID:0:8})

Modified files:
${MODIFIED_FILES}

Statistics: ${STATS}
Timestamp: ${TIMESTAMP}

Co-Authored-By: Claude <noreply@anthropic.com>"
fi

git add -A

if git commit -m "$COMMIT_MSG" 2>/dev/null; then
    echo "✅ Auto-commit created after inference completion"
    git push origin "$(git branch --show-current)" 2>/dev/null || true
fi

exit 0
EOF

# Create commit-on-session-end.sh
cat > ~/.claude/hooks/commit-on-session-end.sh <<'EOF'
#!/bin/bash
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
REASON=$(echo "$INPUT" | jq -r '.reason // "unknown"')

cd "$CWD" || exit 0

if ! git rev-parse --git-dir > /dev/null 2>&1; then
    exit 0
fi

if git diff-index --quiet HEAD -- 2>/dev/null; then
    exit 0
fi

TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M:%S UTC")
STATS=$(git diff --stat HEAD 2>/dev/null | tail -1)
MODIFIED_FILES=$(git diff --name-only HEAD 2>/dev/null)

COMMIT_MSG="🤖 Claude session ended (${SESSION_ID:0:8})

Reason: ${REASON}
Statistics: ${STATS}
Timestamp: ${TIMESTAMP}

Co-Authored-By: Claude <noreply@anthropic.com>"

git add -A
git commit -m "$COMMIT_MSG" 2>/dev/null
git push origin "$(git branch --show-current)" 2>/dev/null || true

exit 0
EOF

# Make hooks executable
chmod +x ~/.claude/hooks/commit-on-stop.sh
chmod +x ~/.claude/hooks/commit-on-session-end.sh

echo "✅ Hook scripts created"

# Create or update settings.json
SETTINGS_FILE="$HOME/.claude/settings.json"

if [ -f "$SETTINGS_FILE" ]; then
    echo "⚠️  Settings file exists: $SETTINGS_FILE"
    echo "Please manually add the hooks configuration (see below)"
else
    cat > "$SETTINGS_FILE" <<'EOF'
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/commit-on-stop.sh"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/commit-on-session-end.sh"
          }
        ]
      }
    ]
  }
}
EOF
    echo "✅ Settings file created: $SETTINGS_FILE"
fi

echo ""
echo "======================================================"
echo "  Installation Complete!"
echo "======================================================"
echo ""
echo "Hook scripts installed:"
echo "  ✓ ~/.claude/hooks/commit-on-stop.sh"
echo "  ✓ ~/.claude/hooks/commit-on-session-end.sh"
echo ""
echo "Next steps:"
echo "1. Ensure your project has git initialized:"
echo "   cd /your/project"
echo "   git init"
echo ""
echo "2. (Optional) Configure Gitea remote for auto-push:"
echo "   git remote add origin http://TOKEN@gitea:3000/user/repo.git"
echo ""
echo "3. Test the hook:"
echo "   claude"
echo "   > Create a test file with hello world"
echo "   [Wait for Claude to finish]"
echo "   > Run: git log -1"
echo "   [You should see an auto-commit!]"
echo ""
```

**Run the installation script:**

```bash
# Save the script
chmod +x install-stop-hook.sh

# Run it
./install-stop-hook.sh
```

---

## Testing

### Test 1: Basic Functionality

```bash
# 1. Navigate to a git repository
cd /your/project
git init

# 2. Start Claude Code
claude

# 3. Ask Claude to do something
> Create a Python file called hello.py with a hello world function

# 4. Wait for Claude to finish
# When you see the prompt again, check git log
> Run: git log -1

# Expected output:
# commit abc123def456...
# 🤖 Claude inference complete (Session: 550e8400)
# 
# Summary: I've created a Python file...
```

### Test 2: Manual Testing of Hook

```bash
# Test the hook directly
cd /your/project

# Create some changes
echo "test" > test.txt

# Simulate hook input
echo '{
  "session_id": "test-session-123",
  "cwd": "'$(pwd)'",
  "stop_hook_active": false,
  "transcript_path": ""
}' | ~/.claude/hooks/commit-on-stop.sh

# Check git log
git log -1
```

### Test 3: Verify Hook Configuration

```bash
# Check if hooks are configured
cat ~/.claude/settings.json | jq '.hooks'

# Expected output:
# {
#   "Stop": [
#     {
#       "matcher": "",
#       "hooks": [...]
#     }
#   ],
#   "SessionEnd": [...]
# }
```

---

## Example Git History

After using the Stop hook, your git history will look like this:

```bash
$ git log --oneline

a1b2c3d 🤖 Claude inference complete (550e8400)
e4f5g6h 🤖 Claude inference complete (550e8400)
i7j8k9l 🤖 Claude inference complete (550e8400)
```

Each commit represents one complete inference cycle.

**Detailed view:**

```bash
$ git log -1

commit a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0
Author: Claude AI <claude@anthropic.com>
Date:   Fri Dec 27 23:15:42 2025 +0000

    🤖 Claude inference complete (Session: 550e8400)
    
    Summary: I've created a FastAPI application with JWT authentication,
    including login endpoints, token refresh mechanism, and session
    management. I've also added comprehensive tests and API documentation.
    
    Changes: 8 files changed, 456 insertions(+), 12 deletions(-)
    Timestamp: 2025-12-27 23:15:42 UTC
    
    Co-Authored-By: Claude <noreply@anthropic.com>
```

---

## Troubleshooting

### Problem: Hook not triggering

**Diagnosis:**

```bash
# 1. Check if hook file exists
ls -la ~/.claude/hooks/commit-on-stop.sh

# 2. Check if it's executable
# Should show: -rwxr-xr-x
ls -l ~/.claude/hooks/commit-on-stop.sh

# 3. Check settings configuration
cat ~/.claude/settings.json | jq '.hooks.Stop'
```

**Solution:**

```bash
# Make hook executable
chmod +x ~/.claude/hooks/commit-on-stop.sh

# Verify settings.json has correct configuration
# (see Step 3 above)
```

---

### Problem: Hook triggers but no commit created

**Diagnosis:**

```bash
# 1. Check if in git repository
git rev-parse --git-dir

# 2. Check if there are changes
git status

# 3. Check if jq is installed
which jq
```

**Solution:**

```bash
# Install jq if missing
# Ubuntu/Debian:
apt-get install -y jq

# macOS:
brew install jq

# Fedora/CentOS:
yum install -y jq
```

---

### Problem: Commits created but not pushed

**Diagnosis:**

```bash
# Check git remote
git remote -v

# Test push manually
git push origin main
```

**Solution:**

```bash
# Configure remote with token auth
git remote set-url origin http://YOUR_TOKEN@gitea:3000/user/repo.git

# Or add remote if missing
git remote add origin http://YOUR_TOKEN@gitea:3000/user/repo.git

# Test push
git push -u origin main
```

---

### Problem: Infinite loop (hook keeps triggering)

**Diagnosis:**

This should not happen because the script checks `stop_hook_active` flag.

**Verify the check exists:**

```bash
grep "STOP_HOOK_ACTIVE" ~/.claude/hooks/commit-on-stop.sh
```

**Should see:**

```bash
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
    exit 0
fi
```

If missing, the hook script is incomplete. Reinstall using the complete script above.

---

### Problem: Hook works but commit message is empty

**Diagnosis:**

The transcript path might be invalid or jq is not parsing correctly.

**Solution:**

The script has a fallback that doesn't require the transcript. If `LAST_MESSAGE` is empty, it uses a simpler commit message with just the modified files list.

**To debug:**

```bash
# Add debug output to hook
echo "Transcript: $TRANSCRIPT_PATH" >> /tmp/hook-debug.log
echo "Last message: $LAST_MESSAGE" >> /tmp/hook-debug.log

# Check debug log after next commit
cat /tmp/hook-debug.log
```

---

## Advanced Configuration

### Custom Commit Message Format

Edit `~/.claude/hooks/commit-on-stop.sh` and modify the `COMMIT_MSG` variable:

```bash
# Example: Shorter commit message
COMMIT_MSG="🤖 Auto: ${SESSION_ID:0:8}

${STATS}
${TIMESTAMP}"
```

### Disable Auto-Push

Comment out the push section in the hook:

```bash
# if git push origin "$(git branch --show-current)" 2>/dev/null; then
#     echo "✅ Pushed to Gitea"
# else
#     echo "⚠️  Could not push to remote (this is OK)"
# fi
```

### Add Notification on Commit

Add desktop notification (macOS):

```bash
# After successful commit, add:
osascript -e 'display notification "Git commit created" with title "Claude Code"'
```

Add desktop notification (Linux):

```bash
# After successful commit, add:
notify-send "Claude Code" "Git commit created"
```

### Log All Commits

```bash
# Add logging to hook
COMMIT_HASH=$(git rev-parse HEAD)
echo "$(date): Committed $COMMIT_HASH" >> ~/.claude/commit-log.txt
```

---

## Docker Integration

If using Docker, the hook scripts should be inside the container:

**Dockerfile additions:**

```dockerfile
# Install jq
RUN apt-get update && apt-get install -y jq

# Copy hooks
COPY hooks/ /root/.claude/hooks/
RUN chmod +x /root/.claude/hooks/*.sh

# Copy settings
COPY settings.json /root/.claude/settings.json
```

**docker-compose.yml:**

```yaml
services:
  claude-code:
    build: .
    volumes:
      - ./workspace:/workspace
      - claude-hooks:/root/.claude/hooks
      - claude-config:/root/.claude
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - GITEA_TOKEN=${GITEA_TOKEN}

volumes:
  claude-hooks:
  claude-config:
```

---

## FAQ

**Q: Will the hook trigger if I interrupt Claude with Escape?**

A: No. The Stop hook only triggers when Claude naturally finishes responding, not when interrupted.

---

**Q: Can I use this with multiple projects?**

A: Yes! Use user-level settings (`~/.claude/settings.json`) to apply to all projects, or project-level settings (`.claude/settings.json`) for specific projects.

---

**Q: Does this work with Claude Code web interface?**

A: No. Hooks only work with the Claude Code CLI (terminal interface). The web interface doesn't support hooks.

---

**Q: Will this create a commit if Claude doesn't change any files?**

A: No. The hook checks if there are changes before committing:

```bash
if git diff-index --quiet HEAD -- 2>/dev/null; then
    exit 0  # No changes, skip commit
fi
```

---

**Q: Can I customize which files are committed?**

A: Yes. Modify the hook to use `git add` selectively instead of `git add -A`:

```bash
# Instead of: git add -A
# Use:
git add src/*.py  # Only Python files in src/
```

---

**Q: How do I disable the hook temporarily?**

A: Comment out the hook in settings.json:

```json
{
  "hooks": {
    // "Stop": [...]  <- commented out
  }
}
```

Or rename the hook script:

```bash
mv ~/.claude/hooks/commit-on-stop.sh ~/.claude/hooks/commit-on-stop.sh.disabled
```

---

## Summary

You now have a complete, automated git commit system that:

✅ Creates one commit per Claude Code inference completion
✅ Includes descriptive commit messages with summaries
✅ Automatically pushes to Gitea (if configured)
✅ Prevents infinite loops
✅ Has backup commit on session end
✅ Works in Docker containers
✅ Is easy to customize

**Files created:**
- `~/.claude/hooks/commit-on-stop.sh` - Main hook
- `~/.claude/hooks/commit-on-session-end.sh` - Backup hook
- `~/.claude/settings.json` - Configuration

**Workflow:**
1. Start Claude Code
2. Ask Claude to do work
3. Claude creates/edits files
4. Claude finishes and returns control
5. 🎯 Commit automatically created
6. Ready for next command

No manual intervention needed!
