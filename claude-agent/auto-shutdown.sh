#!/bin/bash
# Auto-shutdown script for Claude agent
# Shuts down after specified idle time

set -e

IDLE_MINUTES=${CLAUDE_AUTO_SHUTDOWN_MINUTES:-30}
ACTIVITY_FILE="/tmp/activity/last_activity"
LOG_FILE="/tmp/activity/shutdown.log"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "🕐 Auto-shutdown monitoring started (idle timeout: ${IDLE_MINUTES} minutes)"

while true; do
    NOW=$(date +%s)

    # Check if activity file exists
    if [ ! -f "$ACTIVITY_FILE" ]; then
        # No activity file yet, create one
        echo "$NOW" > "$ACTIVITY_FILE"
        log "📝 Created activity file"
    fi

    # Read last activity timestamp
    LAST_ACTIVITY=$(cat "$ACTIVITY_FILE" 2>/dev/null || echo "$NOW")

    # Calculate idle time
    IDLE_SECONDS=$((NOW - LAST_ACTIVITY))
    IDLE_MINS=$((IDLE_SECONDS / 60))

    log "⏱️  Idle time: ${IDLE_MINS} minutes (threshold: ${IDLE_MINUTES})"

    # Check if idle threshold exceeded
    if [ "$IDLE_MINS" -ge "$IDLE_MINUTES" ]; then
        log "🛑 Idle timeout reached (${IDLE_MINS} minutes). Shutting down..."

        # Gracefully shutdown any running Claude processes
        pkill -TERM -f "claude" || true

        # Wait a bit for graceful shutdown
        sleep 5

        # Force kill if still running
        pkill -KILL -f "claude" || true

        log "✅ Claude agent shut down successfully"
        exit 0
    fi

    # Sleep for 1 minute before next check
    sleep 60
done
