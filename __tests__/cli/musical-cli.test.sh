#!/bin/bash
#
# Musical CLI Test Suite
#
# Tests for the musical CLI instance manager
#
# Usage:
#   ./musical-cli.test.sh           # Run all tests
#   ./musical-cli.test.sh --unit    # Run unit tests only (no Docker)
#   ./musical-cli.test.sh --integration  # Run integration tests (requires Docker)
#

# Don't use set -e because we want to handle test failures gracefully

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Test counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MUSICAL_CLI="${SCRIPT_DIR}/../../musical"
TEST_INSTANCE="test-$$"
TEST_DIR="/tmp/musical-test-$$"

# Test utilities
log_test() {
    echo -e "${BLUE}[TEST]${NC} $1"
}

log_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    TESTS_PASSED=$((TESTS_PASSED + 1))
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    TESTS_FAILED=$((TESTS_FAILED + 1))
}

run_test() {
    local test_name=$1
    local test_func=$2
    
    TESTS_RUN=$((TESTS_RUN + 1))
    log_test "$test_name"
    
    if $test_func; then
        log_pass "$test_name"
        return 0
    else
        log_fail "$test_name"
        return 1
    fi
}

assert_equals() {
    local expected=$1
    local actual=$2
    local message=${3:-"Values should be equal"}
    
    if [ "$expected" = "$actual" ]; then
        return 0
    else
        echo "  Expected: '$expected'"
        echo "  Actual:   '$actual'"
        return 1
    fi
}

assert_contains() {
    local haystack=$1
    local needle=$2
    local message=${3:-"Should contain substring"}
    
    if echo "$haystack" | grep -F -- "$needle" >/dev/null 2>&1; then
        return 0
    else
        echo "  Expected to contain: '$needle'"
        echo "  In: '$haystack'"
        return 1
    fi
}

assert_not_empty() {
    local value=$1
    local message=${2:-"Value should not be empty"}
    
    if [ -n "$value" ]; then
        return 0
    else
        echo "  Value is empty"
        return 1
    fi
}

assert_exit_code() {
    local expected=$1
    local actual=$2
    
    if [ "$expected" = "$actual" ]; then
        return 0
    else
        echo "  Expected exit code: $expected"
        echo "  Actual exit code: $actual"
        return 1
    fi
}

# ============================================================================
# Unit Tests (no Docker required)
# ============================================================================

test_cli_exists() {
    [ -f "$MUSICAL_CLI" ] && [ -x "$MUSICAL_CLI" ]
}

test_help_command() {
    local output=$("$MUSICAL_CLI" help 2>&1)
    
    assert_contains "$output" "Musical.run Local Server" && \
    assert_contains "$output" "list" && \
    assert_contains "$output" "status" && \
    assert_contains "$output" "start" && \
    assert_contains "$output" "stop" && \
    assert_contains "$output" "restart" && \
    assert_contains "$output" "recreate" && \
    assert_contains "$output" "verify"
}

test_help_alias() {
    local output1=$("$MUSICAL_CLI" help 2>&1)
    local output2=$("$MUSICAL_CLI" --help 2>&1)
    local output3=$("$MUSICAL_CLI" -h 2>&1)
    
    [ "$output1" = "$output2" ] && [ "$output2" = "$output3" ]
}

test_unknown_command() {
    local output
    local exit_code
    output=$("$MUSICAL_CLI" unknown_command_xyz 2>&1)
    exit_code=$?
    
    assert_contains "$output" "Unknown command" && \
    assert_exit_code 1 $exit_code
}

test_start_requires_instance() {
    local output
    local exit_code
    output=$("$MUSICAL_CLI" start 2>&1)
    exit_code=$?
    
    assert_contains "$output" "Usage:" && \
    assert_exit_code 1 $exit_code
}

test_stop_requires_instance() {
    local output
    local exit_code
    output=$("$MUSICAL_CLI" stop 2>&1)
    exit_code=$?
    
    assert_contains "$output" "Usage:" && \
    assert_exit_code 1 $exit_code
}

test_restart_requires_instance() {
    local output
    local exit_code
    output=$("$MUSICAL_CLI" restart 2>&1)
    exit_code=$?
    
    assert_contains "$output" "Usage:" && \
    assert_contains "$output" "force" && \
    assert_exit_code 1 $exit_code
}

test_verify_requires_instance() {
    local output
    local exit_code
    output=$("$MUSICAL_CLI" verify 2>&1)
    exit_code=$?
    
    assert_contains "$output" "Usage:" && \
    assert_exit_code 1 $exit_code
}

test_recreate_requires_instance() {
    local output
    local exit_code
    output=$("$MUSICAL_CLI" recreate 2>&1)
    exit_code=$?
    
    assert_contains "$output" "Usage:" && \
    assert_exit_code 1 $exit_code
}

test_logs_requires_instance() {
    local output
    local exit_code
    output=$("$MUSICAL_CLI" logs 2>&1)
    exit_code=$?
    
    assert_contains "$output" "Usage:" && \
    assert_exit_code 1 $exit_code
}

test_shell_requires_instance() {
    local output
    local exit_code
    output=$("$MUSICAL_CLI" shell 2>&1)
    exit_code=$?
    
    assert_contains "$output" "Usage:" && \
    assert_exit_code 1 $exit_code
}

test_uninstall_requires_instance() {
    local output
    local exit_code
    output=$("$MUSICAL_CLI" uninstall 2>&1)
    exit_code=$?
    
    assert_contains "$output" "Usage:" && \
    assert_exit_code 1 $exit_code
}

test_command_aliases() {
    # Test that aliases work
    local list1=$("$MUSICAL_CLI" list 2>&1 | head -1)
    local list2=$("$MUSICAL_CLI" ls 2>&1 | head -1)
    
    [ "$list1" = "$list2" ]
}

test_status_aliases() {
    # Both should show the same output when no instance is given
    local status1=$("$MUSICAL_CLI" status 2>&1 | head -1)
    local status2=$("$MUSICAL_CLI" st 2>&1 | head -1)
    
    [ "$status1" = "$status2" ]
}

test_help_shows_verify_command() {
    local output=$("$MUSICAL_CLI" help 2>&1)
    
    assert_contains "$output" "verify" && \
    assert_contains "$output" "Check credential consistency"
}

test_help_shows_recreate_command() {
    local output=$("$MUSICAL_CLI" help 2>&1)
    
    assert_contains "$output" "recreate" && \
    assert_contains "$output" "Force recreate containers"
}

test_help_shows_restart_force() {
    local output=$("$MUSICAL_CLI" help 2>&1)
    
    assert_contains "$output" "restart" && \
    assert_contains "$output" "force"
}

test_install_dir_env_var_format() {
    # Test that the help mentions the env var format
    local output=$("$MUSICAL_CLI" help 2>&1)
    
    assert_contains "$output" "MUSICAL_INSTALL_DIR" && \
    assert_contains "$output" "MUSICAL_INSTALL_DIR_<NAME>"
}

# ============================================================================
# Integration Tests (require Docker)
# ============================================================================

test_list_command_runs() {
    # Should not fail even with no instances
    local output
    local exit_code
    output=$("$MUSICAL_CLI" list 2>&1)
    exit_code=$?
    
    assert_contains "$output" "Musical.run Local Server" && \
    assert_exit_code 0 $exit_code
}

test_status_nonexistent_instance() {
    local output
    local exit_code
    output=$("$MUSICAL_CLI" status nonexistent_instance_xyz 2>&1)
    exit_code=$?
    
    assert_contains "$output" "not found" && \
    assert_exit_code 1 $exit_code
}

test_verify_nonexistent_instance() {
    local output
    local exit_code
    output=$("$MUSICAL_CLI" verify nonexistent_instance_xyz 2>&1)
    exit_code=$?
    
    # Should fail because install dir not found
    assert_exit_code 1 $exit_code
}

test_start_nonexistent_install_dir() {
    local output
    local exit_code
    output=$("$MUSICAL_CLI" start nonexistent_instance_xyz 2>&1)
    exit_code=$?
    
    assert_contains "$output" "Cannot find installation directory" && \
    assert_exit_code 1 $exit_code
}

# Test with main instance if it exists
test_main_instance_status() {
    if docker ps -a --format '{{.Names}}' | grep -q "musical-local-main"; then
        local output=$("$MUSICAL_CLI" status main 2>&1)
        local exit_code=$?
        
        assert_contains "$output" "Instance:" && \
        assert_exit_code 0 $exit_code
    else
        echo "  Skipped: main instance not available"
        return 0
    fi
}

test_main_instance_verify() {
    if docker ps --format '{{.Names}}' | grep -q "musical-local-main"; then
        local output=$("$MUSICAL_CLI" verify main 2>&1)
        
        # Should show credential checking output
        assert_contains "$output" "Verifying instance:" && \
        assert_contains "$output" "Checking credential consistency"
    else
        echo "  Skipped: main instance not running"
        return 0
    fi
}

test_verify_checks_all_services() {
    if docker ps --format '{{.Names}}' | grep -q "musical-local-main"; then
        local output=$("$MUSICAL_CLI" verify main 2>&1)
        
        # Should check both local-server and gitea credentials
        assert_contains "$output" "Local server" && \
        assert_contains "$output" "Gitea"
    else
        echo "  Skipped: main instance not running"
        return 0
    fi
}

test_verify_checks_connectivity() {
    if docker ps --format '{{.Names}}' | grep -q "musical-local-main"; then
        local output=$("$MUSICAL_CLI" verify main 2>&1)
        
        # Should check service connectivity
        assert_contains "$output" "Checking service connectivity"
    else
        echo "  Skipped: main instance not running"
        return 0
    fi
}

test_verify_shows_success_on_healthy_instance() {
    if docker ps --format '{{.Names}}' | grep -q "musical-local-main"; then
        local output
        local exit_code
        output=$("$MUSICAL_CLI" verify main 2>&1)
        exit_code=$?
        
        # Should either pass or show issues
        if [ $exit_code -eq 0 ]; then
            assert_contains "$output" "All checks passed"
        else
            assert_contains "$output" "Issues detected"
        fi
    else
        echo "  Skipped: main instance not running"
        return 0
    fi
}

test_recreate_nonexistent_instance() {
    local output
    local exit_code
    output=$("$MUSICAL_CLI" recreate nonexistent_instance_xyz 2>&1)
    exit_code=$?
    
    assert_contains "$output" "Cannot find installation directory" && \
    assert_exit_code 1 $exit_code
}

# ============================================================================
# Environment Variable Tests
# ============================================================================

setup_test_env_file() {
    mkdir -p "$TEST_DIR"
    cat > "$TEST_DIR/.env.${TEST_INSTANCE}" << EOF
INSTANCE_ID=${TEST_INSTANCE}
INSTANCE_NAME=Test Instance
MUSICAL_PORT=19100
GITEA_PORT=19101
GITEA_SSH_PORT=19200
DB_PASSWORD=test_password_12345
GITEA_ADMIN_USER=musical
GITEA_ADMIN_PASSWORD=test_admin_pass
GITEA_SECRET_KEY=test_secret_key
EOF
    
    # Create minimal docker-compose.yml for testing
    cat > "$TEST_DIR/docker-compose.yml" << 'EOF'
services:
  postgres:
    image: postgres:15-alpine
    container_name: musical-postgres-${INSTANCE_ID:-default}
networks:
  musical-network:
    name: musical-network-${INSTANCE_ID:-default}
EOF
}

cleanup_test_env() {
    rm -rf "$TEST_DIR"
    rm -f "$HOME/.musical/instances/${TEST_INSTANCE}/install_dir"
    rmdir "$HOME/.musical/instances/${TEST_INSTANCE}" 2>/dev/null || true
}

test_find_install_dir_with_config_file() {
    setup_test_env_file
    
    # Create config file pointing to test dir
    mkdir -p "$HOME/.musical/instances/${TEST_INSTANCE}"
    echo "$TEST_DIR" > "$HOME/.musical/instances/${TEST_INSTANCE}/install_dir"
    
    # Now start should find the directory (even if it fails to actually start)
    local output=$("$MUSICAL_CLI" start "$TEST_INSTANCE" 2>&1)
    
    # Should not say "Cannot find installation directory"
    if echo "$output" | grep -q "Cannot find installation directory"; then
        cleanup_test_env
        return 1
    fi
    
    cleanup_test_env
    return 0
}

test_find_install_dir_with_env_var() {
    setup_test_env_file
    
    # Set env var
    local env_var="MUSICAL_INSTALL_DIR_$(echo "$TEST_INSTANCE" | tr '[:lower:]-' '[:upper:]_')"
    export "$env_var"="$TEST_DIR"
    
    # Now start should find the directory
    local output=$("$MUSICAL_CLI" start "$TEST_INSTANCE" 2>&1)
    
    # Should not say "Cannot find installation directory"
    if echo "$output" | grep -q "Cannot find installation directory"; then
        unset "$env_var"
        cleanup_test_env
        return 1
    fi
    
    unset "$env_var"
    cleanup_test_env
    return 0
}

# ============================================================================
# Run Tests
# ============================================================================

run_unit_tests() {
    echo -e "${BOLD}${CYAN}━━━ Unit Tests ━━━${NC}"
    echo ""
    
    run_test "CLI script exists and is executable" test_cli_exists
    run_test "Help command shows usage" test_help_command
    run_test "Help aliases work (help, --help, -h)" test_help_alias
    run_test "Unknown command returns error" test_unknown_command
    run_test "Start requires instance argument" test_start_requires_instance
    run_test "Stop requires instance argument" test_stop_requires_instance
    run_test "Restart requires instance argument" test_restart_requires_instance
    run_test "Verify requires instance argument" test_verify_requires_instance
    run_test "Recreate requires instance argument" test_recreate_requires_instance
    run_test "Logs requires instance argument" test_logs_requires_instance
    run_test "Shell requires instance argument" test_shell_requires_instance
    run_test "Uninstall requires instance argument" test_uninstall_requires_instance
    run_test "Command aliases work (list/ls)" test_command_aliases
    run_test "Status aliases work (status/st)" test_status_aliases
    run_test "Help shows verify command" test_help_shows_verify_command
    run_test "Help shows recreate command" test_help_shows_recreate_command
    run_test "Help shows restart --force option" test_help_shows_restart_force
    run_test "Help shows install dir env var format" test_install_dir_env_var_format
    
    echo ""
}

run_integration_tests() {
    echo -e "${BOLD}${CYAN}━━━ Integration Tests ━━━${NC}"
    echo ""
    
    # Check if Docker is available
    if ! docker info >/dev/null 2>&1; then
        echo -e "${YELLOW}Skipping integration tests: Docker not available${NC}"
        return
    fi
    
    run_test "List command runs without error" test_list_command_runs
    run_test "Status of nonexistent instance fails" test_status_nonexistent_instance
    run_test "Verify of nonexistent instance fails" test_verify_nonexistent_instance
    run_test "Start with nonexistent install dir fails" test_start_nonexistent_install_dir
    run_test "Recreate of nonexistent instance fails" test_recreate_nonexistent_instance
    run_test "Main instance status (if available)" test_main_instance_status
    run_test "Main instance verify (if running)" test_main_instance_verify
    run_test "Verify checks all services" test_verify_checks_all_services
    run_test "Verify checks connectivity" test_verify_checks_connectivity
    run_test "Verify shows success on healthy instance" test_verify_shows_success_on_healthy_instance
    
    echo ""
}

run_env_var_tests() {
    echo -e "${BOLD}${CYAN}━━━ Environment Variable Tests ━━━${NC}"
    echo ""
    
    run_test "Find install dir with config file" test_find_install_dir_with_config_file
    run_test "Find install dir with env var" test_find_install_dir_with_env_var
    
    echo ""
}

print_summary() {
    echo -e "${BOLD}━━━ Test Summary ━━━${NC}"
    echo ""
    echo -e "  Tests run:    $TESTS_RUN"
    echo -e "  ${GREEN}Passed:       $TESTS_PASSED${NC}"
    
    if [ $TESTS_FAILED -gt 0 ]; then
        echo -e "  ${RED}Failed:       $TESTS_FAILED${NC}"
    else
        echo -e "  Failed:       $TESTS_FAILED"
    fi
    
    echo ""
    
    if [ $TESTS_FAILED -eq 0 ]; then
        echo -e "${GREEN}${BOLD}All tests passed!${NC}"
        return 0
    else
        echo -e "${RED}${BOLD}Some tests failed!${NC}"
        return 1
    fi
}

# Parse arguments
RUN_UNIT=true
RUN_INTEGRATION=true
RUN_ENV_VAR=true

while [[ $# -gt 0 ]]; do
    case $1 in
        --unit)
            RUN_INTEGRATION=false
            RUN_ENV_VAR=false
            shift
            ;;
        --integration)
            RUN_UNIT=false
            RUN_ENV_VAR=false
            shift
            ;;
        --env-var)
            RUN_UNIT=false
            RUN_INTEGRATION=false
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Run tests
echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║           Musical CLI Test Suite                             ║${NC}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

[ "$RUN_UNIT" = true ] && run_unit_tests
[ "$RUN_INTEGRATION" = true ] && run_integration_tests
[ "$RUN_ENV_VAR" = true ] && run_env_var_tests

print_summary
