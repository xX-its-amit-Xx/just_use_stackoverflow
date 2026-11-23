#!/bin/bash
# Idempotent: (re)start the v2 orchestrators if they are not running. Completed trials are skipped.
cd "$(dirname "$0")"
WORK=${BENCH_WORK_ROOT:-/tmp/lazy-agent-work}; LOGS=${BENCH_LOG_DIR:-$WORK/../logs}; mkdir -p "$WORK" "$LOGS"
export BENCH_WORK_ROOT=$WORK
M=claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5
if ! pgrep -f "run_experiment.py --tasks calc-s1" >/dev/null; then
  setsid nohup python3 run_experiment.py --tasks calc-s1,todo-s1,markdown-s1,calc-s2,markdown-s2,kanban-s3,markdown-s3,pm-s4 \
    --models $M --trials 5 --parallel 4 --seed $RANDOM > "$LOGS/v2_main.log" 2>&1 < /dev/null &
fi
if ! pgrep -f "run_experiment.py --tasks diagram-s5" >/dev/null; then
  setsid nohup python3 run_experiment.py --tasks diagram-s5 --models $M --trials 5 --parallel 2 --seed $RANDOM > "$LOGS/v2_s5.log" 2>&1 < /dev/null &
fi
sleep 3; head -qn1 "$LOGS"/v2_*.log
