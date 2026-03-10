#!/bin/bash
#
# Performance Benchmark for stdio_bus Swarm Coordinator
#
# Tests:
# 1. Message latency (100 messages, 95th percentile target: <100ms)
# 2. Throughput estimation
# 3. Backpressure handling
# 4. Memory footprint
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWARM_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="$SCRIPT_DIR/benchmark.log"
RESULTS_FILE="$SCRIPT_DIR/benchmark-results.txt"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

echo "=== Performance Benchmark: $(date) ===" > "$LOG_FILE"
echo "=== Performance Benchmark Results ===" > "$RESULTS_FILE"
echo "Date: $(date)" >> "$RESULTS_FILE"
echo "" >> "$RESULTS_FILE"

log "Starting performance benchmarks"

# Change to swarm directory
pushd "$SWARM_DIR" > /dev/null

# Helper function to run coordinator with messages
run_bench() {
    local msgs="$1"
    local wait_for="$2"
    local tmpfile=$(mktemp)
    
    set -m
    (echo "$msgs" | node dist/cli.js 2>&1) > "$tmpfile" &
    local pid=$!
    
    local count=0
    while [ $count -lt 50 ]; do
        if grep -q "$wait_for" "$tmpfile" 2>/dev/null; then
            break
        fi
        sleep 0.1
        ((count++))
    done
    
    kill -9 -$pid 2>/dev/null || kill -9 $pid 2>/dev/null || true
    wait $pid 2>/dev/null || true
    
    grep -E '^\{' "$tmpfile" 2>/dev/null || true
    rm -f "$tmpfile"
}

echo ""
log "=========================================="
log "Benchmark 1: Message Latency"
log "=========================================="

# Measure latency for individual messages
LATENCIES=()

for i in $(seq 1 100); do
    START=$(python3 -c "import time; print(int(time.time() * 1000))")
    
    RESPONSE=$(run_bench '{"jsonrpc":"2.0","id":"lat-'$i'","method":"swarm.status","params":{}}' "lat-$i")
    
    END=$(python3 -c "import time; print(int(time.time() * 1000))")
    LATENCY=$((END - START))
    LATENCIES+=($LATENCY)
    
    # Progress indicator
    if [ $((i % 10)) -eq 0 ]; then
        echo -n "."
    fi
done
echo ""

# Calculate statistics
SORTED_LATENCIES=($(printf '%s\n' "${LATENCIES[@]}" | sort -n))
COUNT=${#SORTED_LATENCIES[@]}
P50_IDX=$((COUNT * 50 / 100))
P95_IDX=$((COUNT * 95 / 100))
P99_IDX=$((COUNT * 99 / 100))

P50=${SORTED_LATENCIES[$P50_IDX]}
P95=${SORTED_LATENCIES[$P95_IDX]}
P99=${SORTED_LATENCIES[$P99_IDX]}

# Calculate average
SUM=0
for lat in "${LATENCIES[@]}"; do
    SUM=$((SUM + lat))
done
AVG=$((SUM / COUNT))

log "Latency Results (100 messages):"
log "  Average: ${AVG}ms"
log "  P50: ${P50}ms"
log "  P95: ${P95}ms"
log "  P99: ${P99}ms"

echo "## Message Latency (100 messages)" >> "$RESULTS_FILE"
echo "- Average: ${AVG}ms" >> "$RESULTS_FILE"
echo "- P50: ${P50}ms" >> "$RESULTS_FILE"
echo "- P95: ${P95}ms" >> "$RESULTS_FILE"
echo "- P99: ${P99}ms" >> "$RESULTS_FILE"

if [ $P95 -lt 100 ]; then
    echo -e "${GREEN}✓ PASS${NC}: P95 latency (${P95}ms) < 100ms target"
    echo "- Status: PASS (P95 < 100ms target)" >> "$RESULTS_FILE"
else
    echo -e "${YELLOW}⚠ WARN${NC}: P95 latency (${P95}ms) >= 100ms target"
    echo "- Status: WARN (P95 >= 100ms target)" >> "$RESULTS_FILE"
fi
echo "" >> "$RESULTS_FILE"

echo ""
log "=========================================="
log "Benchmark 2: Throughput Estimation"
log "=========================================="

# Estimate throughput based on latency
# Throughput ≈ 1000 / avg_latency (single-threaded)
if [ $AVG -gt 0 ]; then
    THROUGHPUT=$((1000 / AVG))
else
    THROUGHPUT=0
fi

log "Throughput Estimation:"
log "  Based on average latency: ~${THROUGHPUT} msg/sec (single-threaded)"
log "  Note: Actual throughput depends on parallelism and workload"

echo "## Throughput Estimation" >> "$RESULTS_FILE"
echo "- Estimated: ~${THROUGHPUT} msg/sec (single-threaded)" >> "$RESULTS_FILE"
echo "- Note: Based on average latency of ${AVG}ms" >> "$RESULTS_FILE"
echo "" >> "$RESULTS_FILE"

echo ""
log "=========================================="
log "Benchmark 3: Backpressure Handling"
log "=========================================="

# Test burst handling by sending multiple messages
BURST_SIZE=20
MSGS=""
for i in $(seq 1 $BURST_SIZE); do
    MSGS+='{"jsonrpc":"2.0","id":"burst-'$i'","method":"swarm.status","params":{}}'$'\n'
done

RESPONSES=$(run_bench "$MSGS" "burst-$BURST_SIZE")
PROCESSED=$(echo "$RESPONSES" | grep -c '^\{' 2>/dev/null || echo "0")

log "Backpressure Results:"
log "  Burst size: $BURST_SIZE messages"
log "  Processed: $PROCESSED messages"

echo "## Backpressure Handling" >> "$RESULTS_FILE"
echo "- Burst size: $BURST_SIZE messages" >> "$RESULTS_FILE"
echo "- Processed: $PROCESSED messages" >> "$RESULTS_FILE"

if [ "$PROCESSED" -ge "$BURST_SIZE" ]; then
    echo -e "${GREEN}✓ PASS${NC}: All burst messages processed"
    echo "- Status: PASS (all messages processed)" >> "$RESULTS_FILE"
elif [ "$PROCESSED" -gt 0 ]; then
    echo -e "${YELLOW}⚠ WARN${NC}: Partial burst processing ($PROCESSED/$BURST_SIZE)"
    echo "- Status: WARN (partial processing)" >> "$RESULTS_FILE"
else
    echo -e "${RED}✗ FAIL${NC}: No burst messages processed"
    echo "- Status: FAIL" >> "$RESULTS_FILE"
fi
echo "" >> "$RESULTS_FILE"

echo ""
log "=========================================="
log "Benchmark 4: Memory Footprint"
log "=========================================="

# Note: Memory measurement is approximate due to process lifecycle
log "Memory Footprint:"
log "  Note: Memory measurement requires long-running process"
log "  Baseline Node.js process: ~50-100MB typical"

echo "## Memory Footprint" >> "$RESULTS_FILE"
echo "- Note: Requires long-running process for accurate measurement" >> "$RESULTS_FILE"
echo "- Baseline Node.js process: ~50-100MB typical" >> "$RESULTS_FILE"
echo "" >> "$RESULTS_FILE"

popd > /dev/null

echo ""
log "=========================================="
log "Benchmark Summary"
log "=========================================="

echo ""
echo "Results saved to: $RESULTS_FILE"
cat "$RESULTS_FILE"

log "Benchmark complete"
