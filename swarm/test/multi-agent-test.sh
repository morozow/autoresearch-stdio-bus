#!/bin/bash
#
# Multi-Agent Scenario Test for stdio_bus Swarm Coordinator
#
# Tests multi-agent behavior through coordinator message handling.
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWARM_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="$SCRIPT_DIR/multi-agent-test.log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

TESTS_PASSED=0
TESTS_FAILED=0

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }
pass() { echo -e "${GREEN}✓ PASS${NC}: $1" | tee -a "$LOG_FILE"; ((TESTS_PASSED++)); }
fail() { echo -e "${RED}✗ FAIL${NC}: $1" | tee -a "$LOG_FILE"; ((TESTS_FAILED++)); }

# Function to run coordinator with timeout
run_coordinator() {
    local msgs="$1"
    local wait_for="$2"
    local tmpfile=$(mktemp)
    
    # Start in new process group
    set -m
    (echo "$msgs" | node "$SWARM_DIR/dist/cli.js" 2>&1) > "$tmpfile" &
    local pid=$!
    
    # Wait for expected output
    local count=0
    while [ $count -lt 30 ]; do
        if grep -q "$wait_for" "$tmpfile" 2>/dev/null; then
            break
        fi
        sleep 0.1
        ((count++))
    done
    
    # Kill process group
    kill -9 -$pid 2>/dev/null || kill -9 $pid 2>/dev/null || true
    wait $pid 2>/dev/null || true
    
    grep -E '^\{' "$tmpfile" 2>/dev/null || true
    rm -f "$tmpfile"
}

echo "=== Multi-Agent Test Run: $(date) ===" > "$LOG_FILE"
log "Starting multi-agent tests"

echo ""
log "=========================================="
log "Test 1: Lock queuing between agents"
log "=========================================="

LOCK_MSGS='{"jsonrpc":"2.0","id":"lock-agent0","method":"lock.acquire","params":{"agentId":"agent-0"}}
{"jsonrpc":"2.0","id":"lock-agent1","method":"lock.acquire","params":{"agentId":"agent-1"}}'

RESPONSES=$(run_coordinator "$LOCK_MSGS" "lock-agent1")

LOCK0=$(echo "$RESPONSES" | grep 'lock-agent0' | head -1)
if echo "$LOCK0" | grep -q '"granted":true'; then
    pass "Agent-0 acquired lock"
else
    fail "Agent-0 failed to acquire lock"
fi

LOCK1=$(echo "$RESPONSES" | grep 'lock-agent1' | head -1)
if echo "$LOCK1" | grep -q '"granted":false' && echo "$LOCK1" | grep -q '"queuePosition"'; then
    pass "Agent-1 was queued"
else
    fail "Agent-1 lock queuing failed"
fi

echo ""
log "=========================================="
log "Test 2: Result recording"
log "=========================================="

RESULT_MSGS='{"jsonrpc":"2.0","method":"experiment.result","params":{"commit":"abc0001","valBpb":0.995,"memoryGb":44.0,"status":"keep","description":"from agent-0","agentId":"agent-0","timestamp":"2025-01-15T10:00:00Z","branch":"autoresearch/swarm/agent-0"}}
{"jsonrpc":"2.0","method":"experiment.result","params":{"commit":"abc0002","valBpb":0.990,"memoryGb":44.0,"status":"keep","description":"from agent-1","agentId":"agent-1","timestamp":"2025-01-15T10:01:00Z","branch":"autoresearch/swarm/agent-1"}}
{"jsonrpc":"2.0","id":"check-results","method":"swarm.sync","params":{}}'

RESPONSES=$(run_coordinator "$RESULT_MSGS" "check-results")
SYNC=$(echo "$RESPONSES" | grep 'check-results' | head -1)

if echo "$SYNC" | grep -q '"totalExperiments"'; then
    pass "Results recorded"
else
    fail "Failed to record results"
fi

echo ""
log "=========================================="
log "Test 3: Best val_bpb tracking"
log "=========================================="

BEST_MSGS='{"jsonrpc":"2.0","method":"experiment.result","params":{"commit":"abc0003","valBpb":0.980,"memoryGb":44.0,"status":"keep","description":"best","agentId":"agent-1","timestamp":"2025-01-15T10:02:00Z","branch":"autoresearch/swarm/agent-1"}}
{"jsonrpc":"2.0","id":"check-best","method":"swarm.sync","params":{}}'

RESPONSES=$(run_coordinator "$BEST_MSGS" "check-best")
SYNC=$(echo "$RESPONSES" | grep 'check-best' | head -1)

if echo "$SYNC" | grep -q '"bestValBpb"'; then
    pass "Best val_bpb tracked"
else
    fail "Best val_bpb not tracked"
fi

echo ""
log "=========================================="
log "Test 4: Recent results visibility"
log "=========================================="

if echo "$SYNC" | grep -q '"recentResults"'; then
    pass "Recent results visible"
else
    fail "Recent results not visible"
fi

echo ""
log "=========================================="
log "Summary"
log "=========================================="

echo ""
echo "=========================================="
echo -e "Tests Passed: ${GREEN}$TESTS_PASSED${NC}"
echo -e "Tests Failed: ${RED}$TESTS_FAILED${NC}"
echo "=========================================="

log "Tests Passed: $TESTS_PASSED"
log "Tests Failed: $TESTS_FAILED"

[ $TESTS_FAILED -eq 0 ] && exit 0 || exit 1
