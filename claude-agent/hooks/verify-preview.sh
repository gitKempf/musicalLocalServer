#!/bin/bash
################################################################################
# Preview Verification Hook - Verify preview after Claude commits
#
# This hook is called after commit-on-stop.sh completes.
# It checks if the preview is working and, if not, triggers Claude to fix it.
#
# Environment variables used:
# - PROJECT_ID: The project ID
# - SESSION_ID: The session ID  
# - LOCAL_SERVER_URL: URL to the local server API
# - MAX_AUTO_FIX_ATTEMPTS: Maximum number of auto-fix attempts (default: 3)
################################################################################

# Read JSON input from stdin (same as stop hook)
INPUT=$(cat)

# Parse JSON fields
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

# Get project ID from environment or try to detect from path
PROJECT_ID=${PROJECT_ID:-""}
if [ -z "$PROJECT_ID" ]; then
    # Try to extract from CWD path like /app/projects/project_xxx
    PROJECT_ID=$(echo "$CWD" | grep -oP 'project[_-][a-zA-Z0-9_-]+' | head -1)
fi

# Local server API URL
LOCAL_SERVER_URL=${LOCAL_SERVER_URL:-"http://localhost:17100"}

# Log file for debugging
LOG_FILE="/tmp/preview-verification.log"

log() {
    echo "[$(date -u +"%Y-%m-%d %H:%M:%S")] $1" >> "$LOG_FILE"
}

log "Preview verification started - Project: $PROJECT_ID, Session: $SESSION_ID"

# Skip if no project ID
if [ -z "$PROJECT_ID" ]; then
    log "No project ID found, skipping preview verification"
    exit 0
fi

# Wait a moment for the commit to be pushed and preview to rebuild
sleep 5

# Call the local server API to verify preview
VERIFY_RESULT=$(curl -s -X POST "${LOCAL_SERVER_URL}/api/preview/verify" \
    -H "Content-Type: application/json" \
    -d "{
        \"projectId\": \"$PROJECT_ID\",
        \"sessionId\": \"$SESSION_ID\"
    }" 2>/dev/null)

if [ -z "$VERIFY_RESULT" ]; then
    log "Failed to call preview verification API"
    exit 0
fi

# Parse the result
STATUS=$(echo "$VERIFY_RESULT" | jq -r '.status // "unknown"')
SHOULD_FIX=$(echo "$VERIFY_RESULT" | jq -r '.shouldAutoFix // false')
CLAUDE_PROMPT=$(echo "$VERIFY_RESULT" | jq -r '.claudePrompt // ""')
ERROR_TYPE=$(echo "$VERIFY_RESULT" | jq -r '.error.type // "unknown"')

log "Verification result - Status: $STATUS, Error: $ERROR_TYPE, ShouldFix: $SHOULD_FIX"

# If preview is healthy, we're done
if [ "$STATUS" = "healthy" ]; then
    log "✅ Preview is healthy"
    echo "✅ Preview is working correctly"
    exit 0
fi

# If we shouldn't auto-fix (max attempts reached, etc.), just log
if [ "$SHOULD_FIX" != "true" ]; then
    log "⚠️ Preview has errors but auto-fix is disabled or max attempts reached"
    echo "⚠️ Preview has errors: $ERROR_TYPE"
    exit 0
fi

# If we have a Claude prompt, output it for the parent process to handle
if [ -n "$CLAUDE_PROMPT" ] && [ "$CLAUDE_PROMPT" != "null" ]; then
    log "🔧 Triggering auto-fix for error: $ERROR_TYPE"
    echo "🔧 Preview error detected, triggering auto-fix..."
    
    # Output the fix prompt in a structured format
    # This will be picked up by the session manager to continue Claude
    echo "---AUTOFIX_PROMPT_START---"
    echo "$CLAUDE_PROMPT"
    echo ""
    echo "Please fix this issue and commit the changes. After fixing, the preview will be automatically rechecked."
    echo "---AUTOFIX_PROMPT_END---"
    
    # Record the auto-fix attempt via API
    curl -s -X POST "${LOCAL_SERVER_URL}/api/preview/record-fix-attempt" \
        -H "Content-Type: application/json" \
        -d "{\"projectId\": \"$PROJECT_ID\"}" >/dev/null 2>&1
    
    log "Auto-fix prompt sent to Claude"
fi

exit 0
