#!/bin/bash
set -e

echo "========================================="
echo "🧪 Complete Tunnel Flow Test"
echo "========================================="
echo ""

USER_ID="17"
TUNNEL_ROUTER_URL="http://localhost:17200"

# Test 1: Check tunnel status
echo "Test 1: Checking tunnel status..."
TUNNEL_STATUS=$(curl -s "$TUNNEL_ROUTER_URL/api/tunnel/status/$USER_ID")
CONNECTED=$(echo "$TUNNEL_STATUS" | jq -r '.connected')

if [ "$CONNECTED" != "true" ]; then
  echo "❌ FAILED: Tunnel not connected"
  echo "$TUNNEL_STATUS"
  exit 1
fi
echo "✅ PASSED: Tunnel is connected"
echo ""

# Test 2: Get a valid token from the database directly
echo "Test 2: Getting valid access token from database..."
ACCESS_TOKEN=$(docker exec musical-postgres psql -U musical -d musical_cloud -t -c \
  "SELECT access_token FROM user_sessions WHERE user_id = 17 ORDER BY created_at DESC LIMIT 1" | tr -d ' ')

if [ -z "$ACCESS_TOKEN" ]; then
  echo "❌ FAILED: No token found in database"
  exit 1
fi
echo "✅ PASSED: Got token from database"
echo ""

# Test 3: Create project via proxy
echo "Test 3: Creating project via tunnel proxy..."
PROJECT_RESPONSE=$(curl -s -X POST "$TUNNEL_ROUTER_URL/api/tunnel/proxy/$USER_ID" \
  -H "Content-Type: application/json" \
  -d "{
    \"method\": \"POST\",
    \"path\": \"/api/projects\",
    \"headers\": {
      \"Authorization\": \"Bearer $ACCESS_TOKEN\"
    },
    \"body\": {
      \"name\": \"Test Flow $(date +%s)\",
      \"template\": \"react-native\",
      \"initialPrompt\": \"todo list app\"
    }
  }")

PROJECT_ID=$(echo "$PROJECT_RESPONSE" | jq -r '.project.id // empty')

if [ -z "$PROJECT_ID" ]; then
  echo "❌ FAILED: Could not create project"
  echo "$PROJECT_RESPONSE"
  exit 1
fi
echo "✅ PASSED: Created project $PROJECT_ID"
echo ""

# Test 4: Create session via proxy
echo "Test 4: Creating session via tunnel proxy..."
SESSION_RESPONSE=$(curl -s -X POST "$TUNNEL_ROUTER_URL/api/tunnel/proxy/$USER_ID" \
  -H "Content-Type: application/json" \
  -d "{
    \"method\": \"POST\",
    \"path\": \"/api/sessions/create\",
    \"headers\": {
      \"Authorization\": \"Bearer $ACCESS_TOKEN\"
    },
    \"body\": {
      \"projectId\": \"$PROJECT_ID\"
    }
  }")

SESSION_ID=$(echo "$SESSION_RESPONSE" | jq -r '.sessionId // empty')

if [ -z "$SESSION_ID" ]; then
  echo "❌ FAILED: Could not create session"
  echo "$SESSION_RESPONSE"
  exit 1
fi
echo "✅ PASSED: Created session $SESSION_ID"
echo ""

# Test 5: Verify session format is UUID
echo "Test 5: Verifying session ID is valid UUID..."
if [[ ! "$SESSION_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "❌ FAILED: Session ID is not a valid UUID: $SESSION_ID"
  exit 1
fi
echo "✅ PASSED: Session ID is valid UUID"
echo ""

# Test 6: Check Claude agent has the session
echo "Test 6: Checking Claude agent registered session..."
sleep 2
CLAUDE_LOGS=$(docker logs musical-claude-agent --tail 20 2>&1)
if echo "$CLAUDE_LOGS" | grep -q "Session created: $SESSION_ID"; then
  echo "✅ PASSED: Session registered in Claude agent"
else
  echo "❌ FAILED: Session not found in Claude agent logs"
  echo "$CLAUDE_LOGS"
  exit 1
fi
echo ""

echo "========================================="
echo "✅ ALL TESTS PASSED!"
echo "========================================="
echo ""
echo "Summary:"
echo "  - Tunnel: Connected"
echo "  - Project: Created ($PROJECT_ID)"
echo "  - Session: Created ($SESSION_ID)"
echo "  - Format: Valid UUID"
echo "  - Claude Agent: Registered"
echo ""
echo "Ready for message routing test!"
