#!/bin/bash
# Comprehensive Test Script for Musical.run Local Server
# Tests projects, containers, and authentication with AUTO_AUTH_ENABLED=true

set -e

echo "======================================"
echo "Musical.run Local Server - Full Test Suite"
echo "Testing with AUTO_AUTH_ENABLED=true"
echo "======================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test counter
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Function to run a test
run_test() {
    local test_name="$1"
    local test_command="$2"

    TESTS_RUN=$((TESTS_RUN + 1))
    echo -e "${BLUE}Test $TESTS_RUN: $test_name${NC}"

    if eval "$test_command"; then
        echo -e "${GREEN}✅ PASS${NC}"
        TESTS_PASSED=$((TESTS_PASSED + 1))
        echo ""
        return 0
    else
        echo -e "${RED}❌ FAIL${NC}"
        TESTS_FAILED=$((TESTS_FAILED + 1))
        echo ""
        return 1
    fi
}

# Wait for service to be ready
wait_for_service() {
    local url="$1"
    local max_attempts=30
    local attempt=0

    echo "Waiting for service at $url..."

    while [ $attempt -lt $max_attempts ]; do
        if curl -s -f "$url" > /dev/null 2>&1; then
            echo "Service is ready!"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 1
    done

    echo "Service failed to become ready after $max_attempts seconds"
    return 1
}

# Step 1: Rebuild with latest code
echo "======================================"
echo "Step 1: Rebuild Docker images"
echo "======================================"
docker-compose build --no-cache musical-local-server
echo ""

# Step 2: Stop any running containers
echo "======================================"
echo "Step 2: Clean up existing containers"
echo "======================================"
docker-compose down
# Clean up any project containers
docker ps -a --filter "name=project-" --format "{{.ID}}" | xargs -r docker rm -f
echo ""

# Step 3: Start with AUTO_AUTH_ENABLED=true (but no credentials - should fail gracefully)
echo "======================================"
echo "Step 3: Start server with AUTO_AUTH_ENABLED=true (no creds)"
echo "======================================"
export AUTO_AUTH_ENABLED=true
docker-compose up -d musical-local-server
echo ""

# Step 4: Wait for server to be ready
echo "======================================"
echo "Step 4: Wait for server startup"
echo "======================================"
wait_for_service "http://localhost:17100/health"
echo ""

# Step 5: Check server logs
echo "======================================"
echo "Step 5: Check server logs"
echo "======================================"
docker logs musical-local 2>&1 | tail -30
echo ""

# Step 6: Run health check
run_test "Health check" \
    "curl -s http://localhost:17100/health | jq -e '.status == \"healthy\"'"

# Step 7: Check authentication status (should be false since no creds provided)
run_test "Authentication status (unauthenticated)" \
    "curl -s http://localhost:17100/api/auth/status | jq -e '.success == true and .authenticated == false'"

# Step 8: Create a project
echo "======================================"
echo "Creating test project..."
echo "======================================"
PROJECT_RESPONSE=$(curl -s -X POST http://localhost:17100/api/projects \
    -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjE3LCJlbWFpbCI6InRlc3RAdGVzdC5jb20ifQ.test" \
    -H "Content-Type: application/json" \
    -d '{"name":"Auth Test Project","description":"Testing with AUTH enabled","template":"react-native"}')

PROJECT_ID=$(echo "$PROJECT_RESPONSE" | jq -r '.project.id')
echo "Project created: $PROJECT_ID"
echo ""

run_test "Project creation" \
    "echo '$PROJECT_RESPONSE' | jq -e '.success == true'"

# Step 9: Create a session (should create real container)
echo "======================================"
echo "Creating session (container)..."
echo "======================================"
SESSION_RESPONSE=$(curl -s -X POST http://localhost:17100/api/sessions/create \
    -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjE3LCJlbWFpbCI6InRlc3RAdGVzdC5jb20ifQ.test" \
    -H "Content-Type: application/json" \
    -d "{\"projectId\":\"$PROJECT_ID\"}")

SESSION_ID=$(echo "$SESSION_RESPONSE" | jq -r '.sessionId')
CONTAINER_ID=$(echo "$SESSION_RESPONSE" | jq -r '.containerId')
DOCKER_ID=$(echo "$SESSION_RESPONSE" | jq -r '.dockerId')

echo "Session created: $SESSION_ID"
echo "Container ID: $CONTAINER_ID"
echo "Docker ID: $DOCKER_ID"
echo ""

run_test "Session creation" \
    "echo '$SESSION_RESPONSE' | jq -e '.success == true'"

run_test "Container ID returned" \
    "echo '$SESSION_RESPONSE' | jq -e '.containerId != null'"

# Step 10: Verify real Docker container exists
run_test "Real Docker container running" \
    "docker ps --filter name=$CONTAINER_ID --format '{{.Names}}' | grep -q $CONTAINER_ID"

# Step 11: Check container ports
run_test "Container ports mapped" \
    "docker port $DOCKER_ID | grep -q '3000/tcp'"

# Step 12: Verify Git configuration in container
run_test "Git configured in container" \
    "docker exec $DOCKER_ID git config --global user.email | grep -q '@musical.run'"

# Step 13: Check database - project record
run_test "Project in database" \
    "docker exec musical-postgres-local psql -U musical musical_local -tc \"SELECT COUNT(*) FROM projects WHERE id = '$PROJECT_ID'\" | grep -q '1'"

# Step 14: Check database - session record
run_test "Session in database" \
    "docker exec musical-postgres-local psql -U musical musical_local -tc \"SELECT COUNT(*) FROM sessions WHERE id = '$SESSION_ID'\" | grep -q '1'"

# Step 15: Check database - container_id stored
run_test "Container ID in database" \
    "docker exec musical-postgres-local psql -U musical musical_local -tc \"SELECT container_id FROM projects WHERE id = '$PROJECT_ID'\" | grep -q '$CONTAINER_ID'"

# Step 16: Test API root endpoint
run_test "API root endpoint" \
    "curl -s http://localhost:17100/ | jq -e '.name == \"Musical.run Local Server\"'"

# Step 17: Test status endpoint
run_test "Status endpoint" \
    "curl -s http://localhost:17100/api/status | jq -e '.success == true'"

# Step 18: Verify server didn't crash from auth failure
run_test "Server still healthy after auth attempt" \
    "curl -s http://localhost:17100/health | jq -e '.status == \"healthy\"'"

# Step 19: Check server logs for proper auth failure message
run_test "Auth failure handled gracefully" \
    "docker logs musical-local 2>&1 | grep -q 'Local server will work in offline mode'"

# Step 20: Verify container can execute commands
run_test "Container exec works" \
    "docker exec $DOCKER_ID echo 'test' | grep -q 'test'"

# Final summary
echo ""
echo "======================================"
echo "Test Summary"
echo "======================================"
echo -e "Total tests run: $TESTS_RUN"
echo -e "${GREEN}Tests passed: $TESTS_PASSED${NC}"
echo -e "${RED}Tests failed: $TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}✅ ALL TESTS PASSED!${NC}"
    echo ""
    echo "======================================"
    echo "Container Details"
    echo "======================================"
    docker ps --filter "name=project-" --format "table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}"
    echo ""
    echo "======================================"
    echo "Database Records"
    echo "======================================"
    docker exec musical-postgres-local psql -U musical musical_local -c "SELECT id, name, container_id FROM projects WHERE id = '$PROJECT_ID';"
    echo ""
    docker exec musical-postgres-local psql -U musical musical_local -c "SELECT id, container_id, status FROM sessions WHERE id = '$SESSION_ID';"
    echo ""
    exit 0
else
    echo -e "${RED}❌ SOME TESTS FAILED${NC}"
    echo ""
    echo "======================================"
    echo "Recent Server Logs"
    echo "======================================"
    docker logs musical-local 2>&1 | tail -50
    echo ""
    exit 1
fi
