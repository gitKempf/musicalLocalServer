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

# Log file for debugging
LOG_FILE="/tmp/claude-hooks.log"

log() {
    echo "[$(date -u +"%Y-%m-%d %H:%M:%S")] $1" >> "$LOG_FILE"
}

log "SessionEnd hook triggered - Session: $SESSION_ID, Reason: $REASON"

# Change to working directory
cd "$CWD" || {
    log "Failed to change to directory: $CWD"
    exit 0
}

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    log "Not a git repository, skipping session end commit"
    exit 0
fi

# Check if there are changes to commit
if git diff-index --quiet HEAD -- 2>/dev/null; then
    # Also check for untracked files
    if [ -z "$(git ls-files --others --exclude-standard)" ]; then
        log "No uncommitted changes at session end"
        exit 0
    fi
fi

# Create timestamp
TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M:%S UTC")

# Get session statistics
STATS=$(git diff --stat HEAD 2>/dev/null | tail -1)
MODIFIED_FILES=$(git diff --name-only HEAD 2>/dev/null)
UNTRACKED_FILES=$(git ls-files --others --exclude-standard)

# Combine all files
ALL_FILES="${MODIFIED_FILES}${UNTRACKED_FILES:+
$UNTRACKED_FILES}"

# Build commit message
COMMIT_MSG="🤖 Claude session ended (${SESSION_ID:0:8})

Reason: ${REASON}

Modified files:
${ALL_FILES}

Statistics: ${STATS}
Timestamp: ${TIMESTAMP}

Co-Authored-By: Claude <noreply@anthropic.com>"

# Stage and commit
git add -A

if git commit -m "$COMMIT_MSG" 2>/dev/null; then
    log "✅ Final session commit created"
    echo "✅ Final session commit created"
    
    # Try to push
    CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "main")
    if git push origin "$CURRENT_BRANCH" 2>/dev/null; then
        log "✅ Pushed to remote"
        echo "✅ Pushed to remote"
    else
        log "⚠️ Could not push to remote"
    fi
else
    log "⚠️ No changes to commit at session end"
fi

exit 0
