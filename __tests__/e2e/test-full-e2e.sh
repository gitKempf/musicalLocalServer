#!/bin/bash
set -e

echo "========================================="
echo "🧪 FULL END-TO-END TEST WITH CLEANUP"
echo "========================================="
echo ""

# Cleanup old containers
echo "🧹 Cleaning up old containers..."
docker ps -a --filter "name=project-" --format "{{.Names}}" | xargs -r docker rm -f 2>/dev/null || true
echo "✅ Cleanup complete"
echo ""

# Generate token
echo "🔑 Generating test token..."
TEST_EMAIL="${TEST_EMAIL:-test@example.com}"
TOKEN=$(docker exec musical-auth-service node -e "
const jwt = require('jsonwebtoken');
const secret = process.env.JWT_SECRET || 'musical-run-secret-key';
const token = jwt.sign(
  { userId: 17, email: '${TEST_EMAIL}', jti: 'test-' + Date.now() },
  secret,
  { expiresIn: '1h' }
);
console.log(token);
")
echo "✅ Token generated"
echo ""

# Test 1: Create project
echo "📁 Test 1: Creating project..."
PROJECT_RESPONSE=$(curl -s -X POST "http://localhost:17200/api/tunnel/proxy/17" \
  -H "Content-Type: application/json" \
  -d "{
    \"method\": \"POST\",
    \"path\": \"/api/projects\",
    \"headers\": {
      \"Authorization\": \"Bearer $TOKEN\"
    },
    \"body\": {
      \"name\": \"E2E Test $(date +%s)\",
      \"template\": \"react-native\",
      \"initialPrompt\": \"create a simple hello world app\"
    }
  }")

PROJECT_ID=$(echo "$PROJECT_RESPONSE" | jq -r '.project.id // empty')
if [ -z "$PROJECT_ID" ]; then
  echo "❌ FAILED: Could not create project"
  echo "$PROJECT_RESPONSE"
  exit 1
fi
echo "✅ Project created: $PROJECT_ID"
echo ""

# Test 2: Create session
echo "🔧 Test 2: Creating session..."
SESSION_RESPONSE=$(curl -s -X POST "http://localhost:17200/api/tunnel/proxy/17" \
  -H "Content-Type: application/json" \
  -d "{
    \"method\": \"POST\",
    \"path\": \"/api/sessions/create\",
    \"headers\": {
      \"Authorization\": \"Bearer $TOKEN\"
    },
    \"body\": {
      \"projectId\": \"$PROJECT_ID\"
    }
  }")

SESSION_ID=$(echo "$SESSION_RESPONSE" | jq -r '.sessionId // empty')
if [ -z "$SESSION_ID" ]; then
  echo "❌ FAILED: Could not create session"
  echo "$SESSION_RESPONSE" | jq '.'
  exit 1
fi
echo "✅ Session created: $SESSION_ID"
echo ""

# Test 3: Verify UUID
echo "🔍 Test 3: Verifying session ID format..."
if [[ ! "$SESSION_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "❌ FAILED: Not a valid UUID: $SESSION_ID"
  exit 1
fi
echo "✅ Valid UUID format"
echo ""

# Test 4: Check Claude agent
echo "🤖 Test 4: Checking Claude agent registration..."
sleep 2
if docker logs musical-claude-agent --tail 20 2>&1 | grep -q "Session created: $SESSION_ID"; then
  echo "✅ Session registered in Claude agent"
else
  echo "❌ FAILED: Session not in Claude agent"
  docker logs musical-claude-agent --tail 20
  exit 1
fi
echo ""

echo "========================================="
echo "✅ ALL TESTS PASSED!"
echo "========================================="
echo ""
echo "Summary:"
echo "  Project ID: $PROJECT_ID"
echo "  Session ID: $SESSION_ID"
echo "  Format: UUID ✓"
echo "  Claude Agent: Registered ✓"
echo ""
echo "🎉 Ready for browser testing!"
