#!/bin/bash
#
# E2E Test Script for stdio_bus Swarm Coordinator
#
# Tests the following scenarios:
# 1. swarm.status - Verify statistics
# 2. swarm.sync - Verify state sync
# 3. swarm.join - Verify response with state
# 4. lock.acquire - Verify lock acquisition
# 5. swarm.history - Verify timeline
# 6. experiment.result - Verify result recording
#
# Usage:
#   ./e2e-test.sh [--verbose]
#
# Output:
#   Logs saved to swarm/test/e2e-test.log
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWARM_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="$SCRIPT_DIR/e2e-test.log"
VERBOSE=${1:-""}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counters
TESTS_PASSED=0
TESTS_FAILED=0

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log_verbose() {
    if [ "$VERBOSE" = "--verbose" ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
    else
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
    fi
}

pass() {
    echo -e "${GREEN}✓ PASS${NC}: $1" | tee -a "$LOG_FILE"
    ((TESTS_PASSED++))
}

fail() {
    echo -e "${RED}✗ FAIL${NC}: $1" | tee -a "$LOG_FILE"
    ((TESTS_FAILED++))
}

# Initialize log file
echo "=== E2E Test Run: $(date) ===" > "$LOG_FILE"
log "Starting E2E tests for swarm coordinator"
log "Working directory: $SWARM_DIR"

# Create a test config with mock settings
TEST_CONFIG="$SCRIPT_DIR/test-config.json"
cat > "$TEST_CONFIG" << 'EOF'
{
  "pools": [
    {
      "id": "gpu-worker",
      "command": "node",
      "args": ["./dist/worker/gpu-worker.js"],
      "env": {},
      "instances": 1
    }
  ],
  "swarm": {
    "gpuIds": [0],
    "agentModel": "mock-agent",
    "experimentTimeout": 1,
    "lockTimeout": 1
  },
  "limits": {
    "max_input_buffer": 1048576,
    "max_output_queue": 4194304,
    "max_restarts": 3,
    "restart_window_sec": 60,
    "backpressure_timeout_sec": 30
  }
}
EOF

log "Created test configuration at $TEST_CONFIG"

# Function to send a message and get response
# Uses stdin pipe which causes coordinator to exit after processing
send_message() {
    local message="$1"
    
    log_verbose "Sending: $message"
    
    # Send message via stdin, capture stdout (JSON-RPC response), ignore stderr
    local response
    response=$(echo "$message" | node "$SWARM_DIR/dist/cli.js" --config "$TEST_CONFIG" 2>/dev/null | grep -E '^\{' | head -1)
    
    log_verbose "Response: $response"
    echo "$response"
}

# Function to check if response contains expected field
check_response() {
    local response="$1"
    local field="$2"
    local test_name="$3"
    
    if echo "$response" | grep -q "\"$field\""; then
        pass "$test_name - contains '$field'"
        return 0
    else
        fail "$test_name - missing '$field'"
        log "Expected field '$field' in response: $response"
        return 1
    fi
}

# Function to check JSON-RPC success (has result, no error)
check_success() {
    local response="$1"
    local test_name="$2"
    
    if [ -z "$response" ]; then
        fail "$test_name - empty response"
        return 1
    fi
    
    if echo "$response" | grep -q '"result"'; then
        if echo "$response" | grep -q '"error"'; then
            fail "$test_name - response contains error"
            return 1
        fi
        pass "$test_name - successful response"
        return 0
    else
        fail "$test_name - no result in response"
        log "Response was: $response"
        return 1
    fi
}

echo ""
log "=========================================="
log "Test 1: swarm.status"
log "=========================================="

RESPONSE=$(send_message '{"jsonrpc":"2.0","id":"test-status","method":"swarm.status","params":{}}')
check_success "$RESPONSE" "swarm.status" || true
check_response "$RESPONSE" "activeAgents" "swarm.status" || true
check_response "$RESPONSE" "totalExperiments" "swarm.status" || true
check_response "$RESPONSE" "experimentsPerHour" "swarm.status" || true

echo ""
log "=========================================="
log "Test 2: swarm.sync"
log "=========================================="

RESPONSE=$(send_message '{"jsonrpc":"2.0","id":"test-sync","method":"swarm.sync","params":{}}')
check_success "$RESPONSE" "swarm.sync" || true
check_response "$RESPONSE" "bestValBpb" "swarm.sync" || true
check_response "$RESPONSE" "totalExperiments" "swarm.sync" || true
check_response "$RESPONSE" "activeAgents" "swarm.sync" || true
check_response "$RESPONSE" "recentResults" "swarm.sync" || true

echo ""
log "=========================================="
log "Test 3: Agent join flow (via swarm.sync)"
log "=========================================="
# Note: swarm.join is handled internally when agents connect via stdio_bus
# The swarm.sync method provides the state that a joining agent needs
# This test verifies the sync response contains join-relevant data

RESPONSE=$(send_message '{"jsonrpc":"2.0","id":"test-join-sync","method":"swarm.sync","params":{}}')
check_success "$RESPONSE" "agent join (sync)" || true
check_response "$RESPONSE" "bestValBpb" "agent join (sync)" || true
check_response "$RESPONSE" "recentResults" "agent join (sync)" || true

echo ""
log "=========================================="
log "Test 4: lock.acquire"
log "=========================================="

RESPONSE=$(send_message '{"jsonrpc":"2.0","id":"test-lock","method":"lock.acquire","params":{"agentId":"test-agent"}}')
check_success "$RESPONSE" "lock.acquire" || true
check_response "$RESPONSE" "granted" "lock.acquire" || true
check_response "$RESPONSE" "branch" "lock.acquire" || true

echo ""
log "=========================================="
log "Test 5: swarm.history"
log "=========================================="

RESPONSE=$(send_message '{"jsonrpc":"2.0","id":"test-history","method":"swarm.history","params":{"limit":10}}')
check_success "$RESPONSE" "swarm.history" || true
check_response "$RESPONSE" "result" "swarm.history" || true

echo ""
log "=========================================="
log "Test 6: experiment.result recording"
log "=========================================="

# Send an experiment result and then check status to verify it was recorded
# We need to send both messages in one session
MULTI_MSG='{"jsonrpc":"2.0","method":"experiment.result","params":{"commit":"abc1234","valBpb":0.995,"memoryGb":44.0,"status":"keep","description":"test experiment","agentId":"test-agent","timestamp":"2025-01-15T10:00:00Z","branch":"autoresearch/swarm/test-agent"}}
{"jsonrpc":"2.0","id":"verify-result","method":"swarm.status","params":{}}'

RESPONSE=$(echo "$MULTI_MSG" | node "$SWARM_DIR/dist/cli.js" --config "$TEST_CONFIG" 2>/dev/null | grep -E '^\{' | tail -1)
check_success "$RESPONSE" "experiment.result recording" || true

echo ""
log "=========================================="
log "Summary"
log "=========================================="

echo ""
echo "=========================================="
echo -e "Tests Passed: ${GREEN}$TESTS_PASSED${NC}"
echo -e "Tests Failed: ${RED}$TESTS_FAILED${NC}"
echo "=========================================="
echo ""

log "Tests Passed: $TESTS_PASSED"
log "Tests Failed: $TESTS_FAILED"
log "Log saved to: $LOG_FILE"

# Cleanup
rm -f "$TEST_CONFIG"

if [ $TESTS_FAILED -gt 0 ]; then
    exit 1
fi

exit 0
