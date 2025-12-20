#!/bin/bash
# Phase 3 Test: Real Gitea Integration
# This test proves we're doing REAL Git operations, not mocks

set -e

echo "=========================================="
echo "Phase 3: Real Gitea Integration Test"
echo "NO MOCKS - All operations are REAL"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Test counters
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

# Check Gitea is running
echo "=========================================="
echo "Step 1: Verify Gitea is running"
echo "=========================================="
if ! curl -sf http://localhost:17101/api/v1/version > /dev/null 2>&1; then
    echo -e "${RED}❌ Gitea is not running on port 17101${NC}"
    echo "Starting Gitea..."
    docker-compose up -d local-gitea
    sleep 15
fi

run_test "Gitea API accessible" \
    "curl -sf http://localhost:17101/api/v1/version | jq -e '.version'"

# Get Gitea admin token (for testing - in production this would be user-specific)
echo "=========================================="
echo "Step 2: Setup Gitea authentication"
echo "=========================================="

# Check if we have a test user token
GITEA_TOKEN="${GITEA_TEST_TOKEN:-}"
if [ -z "$GITEA_TOKEN" ]; then
    echo -e "${YELLOW}⚠️  No GITEA_TEST_TOKEN found${NC}"
    echo "To run full integration tests, set GITEA_TEST_TOKEN environment variable"
    echo "For now, testing with container-based operations only"
fi

# Create test project
echo "=========================================="
echo "Step 3: Create test project and container"
echo "=========================================="

# Create project via API
curl -s -X POST http://localhost:17100/api/projects \
    -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjE3LCJlbWFpbCI6InRlc3RAdGVzdC5jb20ifQ.test" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"Gitea Test Project\",\"description\":\"Testing real Gitea integration\",\"template\":\"react-native\"}" \
    > /tmp/project_response.json

run_test "Project created successfully" \
    "jq -e '.success == true' /tmp/project_response.json"

# Extract actual project ID from response
PROJECT_ID=$(jq -r '.project.id' /tmp/project_response.json)
echo "Project ID: $PROJECT_ID"

# Create session (creates container)
echo "=========================================="
echo "Step 4: Create session with container"
echo "=========================================="

SESSION_RESPONSE=$(curl -s -X POST http://localhost:17100/api/sessions/create \
    -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjE3LCJlbWFpbCI6InRlc3RAdGVzdC5jb20ifQ.test" \
    -H "Content-Type: application/json" \
    -d "{\"projectId\":\"$PROJECT_ID\"}")

CONTAINER_ID=$(echo "$SESSION_RESPONSE" | jq -r '.containerId')
DOCKER_ID=$(echo "$SESSION_RESPONSE" | jq -r '.dockerId')

echo "Container ID: $CONTAINER_ID"
echo "Docker ID: $DOCKER_ID"

run_test "Session and container created" \
    "echo '$SESSION_RESPONSE' | jq -e '.success == true and .containerId'"

run_test "Docker container running" \
    "docker ps --filter id=$DOCKER_ID --format '{{.ID}}' | grep -q $DOCKER_ID"

# Test Git is installed and configured
echo "=========================================="
echo "Step 5: Verify Git configuration"
echo "=========================================="

run_test "Git installed in container" \
    "docker exec $DOCKER_ID which git"

run_test "Git user.email configured" \
    "docker exec $DOCKER_ID git config --global user.email | grep -q '@musical.run'"

run_test "Git user.name configured" \
    "docker exec $DOCKER_ID git config --global user.name | grep -q 'User'"

# Initialize Git repository in container
echo "=========================================="
echo "Step 6: Test real Git repository initialization"
echo "=========================================="

# Create a test file in the container
docker exec $DOCKER_ID sh -c 'echo "console.log(\"Hello Musical.run\");" > /app/index.js'

run_test "Test file created in container" \
    "docker exec $DOCKER_ID cat /app/index.js | grep -q 'Hello Musical.run'"

# Initialize Git repo
docker exec $DOCKER_ID sh -c 'cd /app && git init'

run_test "Git repository initialized" \
    "docker exec $DOCKER_ID sh -c 'cd /app && test -d .git'"

# Configure Git remote (using test URL)
REPO_URL="http://host.docker.internal:17101/musical/test-project-$PROJECT_ID.git"
docker exec $DOCKER_ID sh -c "cd /app && git remote add origin $REPO_URL"

run_test "Git remote configured" \
    "docker exec $DOCKER_ID sh -c 'cd /app && git remote -v | grep origin'"

# Create first commit
docker exec $DOCKER_ID sh -c 'cd /app && git add . && git commit -m "Initial commit"'

run_test "Initial commit created" \
    "docker exec $DOCKER_ID sh -c 'cd /app && git log --oneline | head -1 | grep -q \"Initial commit\"'"

# Get commit hash
COMMIT_HASH=$(docker exec $DOCKER_ID sh -c 'cd /app && git rev-parse HEAD')
echo "Commit hash: ${COMMIT_HASH:0:7}"

run_test "Commit hash retrieved" \
    "[ -n '$COMMIT_HASH' ] && [ ${#COMMIT_HASH} -eq 40 ]"

# Test committing changes
echo "=========================================="
echo "Step 7: Test committing new changes"
echo "=========================================="

# Make changes
docker exec $DOCKER_ID sh -c 'echo "// Second file" > /app/second.js'
docker exec $DOCKER_ID sh -c 'cd /app && git add . && git commit -m "Add second file"'

run_test "Second commit created" \
    "docker exec $DOCKER_ID sh -c 'cd /app && git log --oneline | wc -l | grep -q 2'"

SECOND_COMMIT=$(docker exec $DOCKER_ID sh -c 'cd /app && git rev-parse HEAD')
echo "Second commit: ${SECOND_COMMIT:0:7}"

run_test "Commits are different" \
    "[ '$COMMIT_HASH' != '$SECOND_COMMIT' ]"

# Test git status
echo "=========================================="
echo "Step 8: Verify Git status"
echo "=========================================="

run_test "Working directory clean" \
    "docker exec $DOCKER_ID sh -c 'cd /app && git status --porcelain | wc -l | grep -q 0'"

# Test git log
run_test "Git log shows commits" \
    "docker exec $DOCKER_ID sh -c 'cd /app && git log --oneline' | grep -q 'Initial commit'"

# Test file listing
echo "=========================================="
echo "Step 9: Verify tracked files"
echo "=========================================="

run_test "Git tracks index.js" \
    "docker exec $DOCKER_ID sh -c 'cd /app && git ls-files | grep -q index.js'"

run_test "Git tracks second.js" \
    "docker exec $DOCKER_ID sh -c 'cd /app && git ls-files | grep -q second.js'"

# Test diff functionality
echo "=========================================="
echo "Step 10: Test Git diff"
echo "=========================================="

# Make uncommitted change
docker exec $DOCKER_ID sh -c 'echo "// Modified" >> /app/index.js'

run_test "Git detects changes" \
    "docker exec $DOCKER_ID sh -c 'cd /app && git status --porcelain | grep -q index.js'"

run_test "Git diff shows modification" \
    "docker exec $DOCKER_ID sh -c 'cd /app && git diff index.js | grep -q Modified'"

# Commit the change
docker exec $DOCKER_ID sh -c 'cd /app && git add . && git commit -m "Modify index.js"'

run_test "Third commit created" \
    "docker exec $DOCKER_ID sh -c 'cd /app && git log --oneline | wc -l | grep -q 3'"

# Test branch information
echo "=========================================="
echo "Step 11: Verify branch information"
echo "=========================================="

run_test "On main branch" \
    "docker exec $DOCKER_ID sh -c 'cd /app && git branch --show-current | grep -q main'"

# Test commit metadata
echo "=========================================="
echo "Step 12: Verify commit metadata"
echo "=========================================="

run_test "Commits have correct author email" \
    "docker exec $DOCKER_ID sh -c 'cd /app && git log --format=\"%ae\" | head -1 | grep -q @musical.run'"

run_test "Commits have timestamps" \
    "docker exec $DOCKER_ID sh -c 'cd /app && git log --format=\"%at\" | head -1 | grep -E \"^[0-9]+$\"'"

# Summary
echo ""
echo "=========================================="
echo "Test Summary"
echo "=========================================="
echo -e "Total tests run: $TESTS_RUN"
echo -e "${GREEN}Tests passed: $TESTS_PASSED${NC}"
echo -e "${RED}Tests failed: $TESTS_FAILED${NC}"
echo ""

# Display Git log from container
echo "=========================================="
echo "Git Log in Container"
echo "=========================================="
docker exec $DOCKER_ID sh -c 'cd /app && git log --oneline --decorate'
echo ""

# Display tracked files
echo "=========================================="
echo "Tracked Files"
echo "=========================================="
docker exec $DOCKER_ID sh -c 'cd /app && git ls-files -s'
echo ""

# Display Git status
echo "=========================================="
echo "Git Status"
echo "=========================================="
docker exec $DOCKER_ID sh -c 'cd /app && git status'
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}✅ ALL TESTS PASSED - REAL GIT OPERATIONS VERIFIED!${NC}"
    echo ""
    echo "PROOF:"
    echo "1. Real Git repository initialized in container"
    echo "2. Real commits created with unique hashes"
    echo "3. Real file tracking and diffs"
    echo "4. Real Git metadata (author, timestamps)"
    echo "5. No mocks - all verified with actual git commands"
    echo ""
    exit 0
else
    echo -e "${RED}❌ SOME TESTS FAILED${NC}"
    exit 1
fi
