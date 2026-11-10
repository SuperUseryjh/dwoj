#!/usr/bin/env sh
# 每 30s 采样 RSS，超过 100 MB 记录告警
# 用法：./scripts/mem_watch.sh <pid> [interval_seconds] [threshold_mb]

PID="${1:-$(cat "$(dirname "$0")/../dwoj.pid" 2>/dev/null)}"
INTERVAL="${2:-30}"
THRESHOLD_MB="${3:-100}"

if [ -z "$PID" ]; then
    echo "用法: $0 <pid> [interval_seconds] [threshold_mb]" >&2
    exit 1
fi

echo "监控 pid=$PID 间隔=${INTERVAL}s 阈值=${THRESHOLD_MB}MB"

while kill -0 "$PID" 2>/dev/null; do
    RSS_KB=$(awk '/VmRSS/ {print $2}' "/proc/$PID/status" 2>/dev/null)
    if [ -n "$RSS_KB" ]; then
        RSS_MB=$((RSS_KB / 1024))
        TS=$(date '+%Y-%m-%d %H:%M:%S')
        if [ "$RSS_MB" -gt "$THRESHOLD_MB" ]; then
            echo "[$TS] WARN pid=$PID rss=${RSS_MB}MB (> ${THRESHOLD_MB}MB)"
        else
            echo "[$TS] ok pid=$PID rss=${RSS_MB}MB"
        fi
    fi
    sleep "$INTERVAL"
done

echo "pid=$PID 已退出，停止监控"
