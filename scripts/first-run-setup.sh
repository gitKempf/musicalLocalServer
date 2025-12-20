#!/bin/bash
#
# Musical.run Local Server - First Run Setup
# This script automatically configures Gitea on first installation
# 
# Usage: ./first-run-setup.sh
#
# This script will:
# 1. Create the secrets directory with proper permissions
# 2. Wait for Gitea to be ready
# 3. Create admin user with secure random password
# 4. Generate API token
# 5. Save credentials for the local server
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
GITEA_URL="${GITEA_URL:-http://localhost:17101}"
GITEA_INTERNAL_URL="${GITEA_INTERNAL_URL:-http://local-gitea:3000}"
GITEA_CONTAINER="${GITEA_CONTAINER:-musical-gitea-local}"
ADMIN_USER="${GITEA_ADMIN_USER:-musical}"
ADMIN_EMAIL="${GITEA_ADMIN_EMAIL:-admin@musical.local}"
SECRETS_DIR="${SECRETS_DIR:-$HOME/.musical/secrets}"
CREDENTIALS_FILE="$SECRETS_DIR/gitea-credentials.json"

# Generate secure random password (32 characters)
generate_password() {
    openssl rand -base64 32 | tr -dc 'a-zA-Z0-9!@#$%^&*' | head -c 32
}

# Generate secure token name
generate_token_name() {
    echo "musical-local-$(date +%s)"
}

echo -e "${BLUE}🎵 Musical.run Local Server - First Run Setup${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""

# Check if already configured
if [ -f "$CREDENTIALS_FILE" ]; then
    echo -e "${YELLOW}⚠️  Gitea credentials already exist at $CREDENTIALS_FILE${NC}"
    echo -e "${YELLOW}   Verifying existing configuration...${NC}"
    
    # Try to verify existing token
    TOKEN=$(jq -r '.token' "$CREDENTIALS_FILE" 2>/dev/null || echo "")
    if [ -n "$TOKEN" ]; then
        if curl -s -f -H "Authorization: token $TOKEN" "$GITEA_URL/api/v1/user" > /dev/null 2>&1; then
            echo -e "${GREEN}✅ Existing credentials are valid${NC}"
            exit 0
        fi
    fi
    
    echo -e "${YELLOW}⚠️  Existing credentials are invalid, regenerating...${NC}"
fi

# Create secrets directory
echo -e "${BLUE}📁 Creating secrets directory...${NC}"
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

# Wait for Gitea to be ready
echo -e "${BLUE}⏳ Waiting for Gitea to be ready...${NC}"
MAX_ATTEMPTS=60
ATTEMPT=0
while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    if curl -s "$GITEA_URL/api/v1/version" > /dev/null 2>&1; then
        VERSION=$(curl -s "$GITEA_URL/api/v1/version" | jq -r '.version' 2>/dev/null || echo "unknown")
        echo -e "${GREEN}✅ Gitea is ready (version: $VERSION)${NC}"
        break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    echo -e "   Waiting... ($ATTEMPT/$MAX_ATTEMPTS)"
    sleep 2
done

if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
    echo -e "${RED}❌ Gitea did not become ready in time${NC}"
    echo -e "${RED}   Please ensure Docker containers are running:${NC}"
    echo -e "${RED}   docker-compose up -d${NC}"
    exit 1
fi

# Generate secure password
ADMIN_PASSWORD=$(generate_password)
echo -e "${BLUE}🔐 Generated secure admin password${NC}"

# Create admin user
echo -e "${BLUE}👤 Creating Gitea admin user: $ADMIN_USER${NC}"

# Check if user already exists
USER_EXISTS=$(docker exec -u git "$GITEA_CONTAINER" sh -c "gitea admin user list 2>&1 | grep -w '$ADMIN_USER' | wc -l")

if [ "$USER_EXISTS" -gt 0 ]; then
    echo -e "${YELLOW}   User already exists, updating password...${NC}"
    docker exec -u git "$GITEA_CONTAINER" sh -c "gitea admin user change-password --username '$ADMIN_USER' --password '$ADMIN_PASSWORD' 2>&1" || {
        echo -e "${RED}❌ Failed to update admin password${NC}"
        exit 1
    }
else
    docker exec -u git "$GITEA_CONTAINER" sh -c "gitea admin user create --username '$ADMIN_USER' --password '$ADMIN_PASSWORD' --email '$ADMIN_EMAIL' --admin --must-change-password=false 2>&1" || {
        echo -e "${RED}❌ Failed to create admin user${NC}"
        exit 1
    }
fi
echo -e "${GREEN}✅ Admin user configured${NC}"

# Generate API token
echo -e "${BLUE}🔑 Generating API token...${NC}"
TOKEN_NAME=$(generate_token_name)

RESPONSE=$(curl -s -X POST "$GITEA_URL/api/v1/users/$ADMIN_USER/tokens" \
    -u "$ADMIN_USER:$ADMIN_PASSWORD" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$TOKEN_NAME\", \"scopes\": [\"write:repository\", \"write:user\", \"write:organization\"]}")

TOKEN=$(echo "$RESPONSE" | jq -r '.sha1' 2>/dev/null)

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    echo -e "${RED}❌ Failed to generate API token${NC}"
    echo -e "${RED}   Response: $RESPONSE${NC}"
    exit 1
fi

echo -e "${GREEN}✅ API token generated: ${TOKEN:0:8}...${NC}"

# Save credentials
echo -e "${BLUE}💾 Saving credentials...${NC}"

cat > "$CREDENTIALS_FILE" << EOF
{
    "url": "$GITEA_INTERNAL_URL",
    "username": "$ADMIN_USER",
    "token": "$TOKEN",
    "password": "$ADMIN_PASSWORD",
    "organization": "musical"
}
EOF

chmod 600 "$CREDENTIALS_FILE"

# Save token separately for convenience
echo "$TOKEN" > "$SECRETS_DIR/gitea-token"
chmod 600 "$SECRETS_DIR/gitea-token"

echo -e "${GREEN}✅ Credentials saved to $CREDENTIALS_FILE${NC}"

# Summary
echo ""
echo -e "${GREEN}🎉 Gitea auto-setup completed successfully!${NC}"
echo ""
echo -e "${BLUE}📋 Configuration Summary:${NC}"
echo -e "   Gitea URL:     $GITEA_URL"
echo -e "   Admin User:    $ADMIN_USER"
echo -e "   Token:         ${TOKEN:0:8}...${TOKEN: -4}"
echo -e "   Credentials:   $CREDENTIALS_FILE"
echo ""
echo -e "${YELLOW}⚠️  Important: The admin password has been saved to the credentials file.${NC}"
echo -e "${YELLOW}   Keep this file secure and do not share it.${NC}"
echo ""
echo -e "${BLUE}🚀 Next steps:${NC}"
echo -e "   1. Restart the local server to pick up new credentials:"
echo -e "      docker-compose restart musical-local-server"
echo -e ""
echo -e "   2. Or set environment variables in .env file:"
echo -e "      GITEA_TOKEN=$TOKEN"
echo -e "      GITEA_USERNAME=$ADMIN_USER"
