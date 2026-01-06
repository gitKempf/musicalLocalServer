#!/bin/bash
################################################################################
# Stop Hook - Commit when Claude finishes inference
#
# Triggers: When Claude Code finishes responding (not on user interrupt)
# Purpose: Create a git commit after each complete inference series
################################################################################

# Source credentials file if available (for containers without env vars)
if [ -f /root/.gitea-credentials ]; then
    source /root/.gitea-credentials
fi

# Read JSON input from stdin
INPUT=$(cat)

# Parse JSON fields
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // ""')
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // "false"')

# Log file for debugging
LOG_FILE="/tmp/claude-hooks.log"

log() {
    echo "[$(date -u +"%Y-%m-%d %H:%M:%S")] $1" >> "$LOG_FILE"
}

log "Stop hook triggered - Session: $SESSION_ID, CWD: $CWD"

# Change to working directory
cd "$CWD" || {
    log "Failed to change to directory: $CWD"
    exit 0
}

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    log "Not a git repository, skipping commit"
    exit 0
fi

# CRITICAL: Prevent infinite loop
# If stop_hook_active is true, we're already in a continuation
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
    log "Stop hook already active, skipping to prevent loop"
    exit 0
fi

# Check if there are changes to commit
if git diff-index --quiet HEAD -- 2>/dev/null; then
    # Also check for untracked files
    if [ -z "$(git ls-files --others --exclude-standard)" ]; then
        log "No changes to commit"
        exit 0
    fi
fi

# Get the last assistant message from transcript (for better commit message)
LAST_MESSAGE=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
    LAST_MESSAGE=$(tail -50 "$TRANSCRIPT_PATH" 2>/dev/null | jq -r 'select(.role == "assistant") | .content[0].text // ""' 2>/dev/null | tail -1 | head -c 200)
fi

# Create timestamp
TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M:%S UTC")

# Get statistics about changes
STATS=$(git diff --stat HEAD 2>/dev/null | tail -1)
MODIFIED_FILES=$(git diff --name-only HEAD 2>/dev/null | head -10)
UNTRACKED_FILES=$(git ls-files --others --exclude-standard | head -5)

# Combine modified and untracked files
ALL_FILES="${MODIFIED_FILES}${UNTRACKED_FILES:+
$UNTRACKED_FILES}"

# Build commit message
if [ -n "$LAST_MESSAGE" ]; then
    COMMIT_MSG="🤖 Claude inference complete (${SESSION_ID:0:8})

Summary: ${LAST_MESSAGE}

Changes:
${ALL_FILES}

Statistics: ${STATS}
Timestamp: ${TIMESTAMP}

Co-Authored-By: Claude <noreply@anthropic.com>"
else
    COMMIT_MSG="🤖 Claude inference complete (${SESSION_ID:0:8})

Modified files:
${ALL_FILES}

Statistics: ${STATS}
Timestamp: ${TIMESTAMP}

Co-Authored-By: Claude <noreply@anthropic.com>"
fi

# Stage all changes
git add -A

# Commit
if git commit -m "$COMMIT_MSG" 2>/dev/null; then
    log "✅ Auto-commit created after Claude inference completion"
    echo "✅ Auto-commit created"
    
    # Try to push (non-blocking)
    CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "main")
    
    # Configure git credentials if GITEA_TOKEN is available
    if [ -n "$GITEA_TOKEN" ] && [ -n "$GITEA_URL" ]; then
        # Get current remote URL
        REMOTE_URL=$(git remote get-url origin 2>/dev/null)
        
        if [ -n "$REMOTE_URL" ]; then
            # Extract the path part (e.g., /musical/project_xxx.git)
            REPO_PATH=$(echo "$REMOTE_URL" | sed -E 's|^https?://[^/]+||')
            
            # Build authenticated URL: http://username:token@host:port/path
            # Extract host and port from GITEA_URL
            GITEA_HOST=$(echo "$GITEA_URL" | sed -E 's|^https?://||')
            GITEA_USER=${GITEA_USERNAME:-${GITEA_USER:-musical}}
            
            # Create authenticated URL
            AUTH_URL="http://${GITEA_USER}:${GITEA_TOKEN}@${GITEA_HOST}${REPO_PATH}"
            
            log "🔑 Using authenticated push URL"
            
            # Push with authenticated URL
            if git push "$AUTH_URL" "$CURRENT_BRANCH" 2>/dev/null; then
                log "✅ Pushed to remote"
                echo "✅ Pushed to remote"
            else
                log "⚠️ Could not push to remote with auth (continuing anyway)"
            fi
        else
            log "⚠️ No remote URL configured"
        fi
    else
        # Fallback: try push without authentication (may fail)
        if git push origin "$CURRENT_BRANCH" 2>/dev/null; then
            log "✅ Pushed to remote"
            echo "✅ Pushed to remote"
        else
            log "⚠️ Could not push to remote - GITEA_TOKEN not available (continuing anyway)"
        fi
    fi
    
    # Call preview verification hook
    SCRIPT_DIR="$(dirname "$0")"
    VERIFY_SCRIPT="$SCRIPT_DIR/verify-preview.sh"
    if [ -f "$VERIFY_SCRIPT" ] && [ -x "$VERIFY_SCRIPT" ]; then
        log "🔍 Running preview verification..."
        echo "$INPUT" | "$VERIFY_SCRIPT"
    fi
else
    log "⚠️ Commit failed (possibly nothing to commit)"
fi

exit 0
