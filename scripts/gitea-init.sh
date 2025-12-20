#!/bin/bash
#
# Gitea initialization script
# This script is run as a health check to ensure Gitea is ready and configured
#

set -e

GITEA_URL="http://localhost:3000"
ADMIN_USER="${GITEA_ADMIN_USER:-musical}"
ADMIN_EMAIL="${GITEA_ADMIN_EMAIL:-admin@musical.local}"
ADMIN_PASSWORD="${GITEA_ADMIN_PASSWORD}"
TOKEN_NAME="musical-local-$(date +%s)"
SECRETS_DIR="/data/gitea/musical-secrets"

# Wait for Gitea to be ready
wait_for_gitea() {
    echo "⏳ Waiting for Gitea to be ready..."
    for i in $(seq 1 60); do
        if curl -s "$GITEA_URL/api/v1/version" > /dev/null 2>&1; then
            echo "✅ Gitea is ready"
            return 0
        fi
        sleep 2
    done
    echo "❌ Gitea did not become ready in time"
    return 1
}

# Check if setup is already complete
check_setup_complete() {
    if [ -f "$SECRETS_DIR/setup-complete" ]; then
        echo "✅ Gitea setup already completed"
        return 0
    fi
    return 1
}

# Create admin user
create_admin_user() {
    echo "👤 Creating admin user: $ADMIN_USER..."
    
    # Check if user exists
    if gitea admin user list | grep -q "$ADMIN_USER"; then
        echo "✅ Admin user already exists"
        return 0
    fi
    
    # Create user
    gitea admin user create \
        --username "$ADMIN_USER" \
        --password "$ADMIN_PASSWORD" \
        --email "$ADMIN_EMAIL" \
        --admin \
        --must-change-password=false
    
    echo "✅ Admin user created"
}

# Generate API token
generate_token() {
    echo "�� Generating API token..."
    
    # Create token via API
    RESPONSE=$(curl -s -X POST "$GITEA_URL/api/v1/users/$ADMIN_USER/tokens" \
        -u "$ADMIN_USER:$ADMIN_PASSWORD" \
        -H "Content-Type: application/json" \
        -d "{\"name\": \"$TOKEN_NAME\", \"scopes\": [\"write:repository\", \"write:user\", \"write:organization\"]}")
    
    TOKEN=$(echo "$RESPONSE" | grep -o '"sha1":"[^"]*"' | cut -d'"' -f4)
    
    if [ -z "$TOKEN" ]; then
        echo "❌ Failed to generate token"
        echo "Response: $RESPONSE"
        return 1
    fi
    
    echo "✅ Token generated: ${TOKEN:0:8}..."
    
    # Save credentials
    mkdir -p "$SECRETS_DIR"
    chmod 700 "$SECRETS_DIR"
    
    echo "$TOKEN" > "$SECRETS_DIR/token"
    chmod 600 "$SECRETS_DIR/token"
    
    cat > "$SECRETS_DIR/credentials.json" << CREDS
{
    "url": "$GITEA_URL",
    "username": "$ADMIN_USER",
    "token": "$TOKEN",
    "organization": "${GITEA_ORGANIZATION:-musical}"
}
CREDS
    chmod 600 "$SECRETS_DIR/credentials.json"
    
    # Mark setup as complete
    touch "$SECRETS_DIR/setup-complete"
    
    echo "✅ Credentials saved to $SECRETS_DIR"
}

# Main
main() {
    if [ -z "$ADMIN_PASSWORD" ]; then
        echo "❌ GITEA_ADMIN_PASSWORD environment variable is required"
        exit 1
    fi
    
    if check_setup_complete; then
        exit 0
    fi
    
    wait_for_gitea || exit 1
    create_admin_user || exit 1
    generate_token || exit 1
    
    echo "🎉 Gitea auto-setup completed successfully!"
}

main "$@"
