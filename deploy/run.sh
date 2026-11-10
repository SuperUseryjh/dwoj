#!/usr/bin/env sh
# 无 systemd 时的兜底启动脚本（替代原 dwoj start）
set -e

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$APP_DIR/log"
PID_FILE="$APP_DIR/dwoj.pid"

mkdir -p "$LOG_DIR"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "dwoj 已在运行 (pid $(cat "$PID_FILE"))"
    exit 0
fi

cd "$APP_DIR"
DWOJ_LOWMEM=1 DWOJ_LOG_CONSOLE=0 PORT="${PORT:-3000}" \
    nohup bun --smol app.ts > /dev/null 2>&1 &

echo $! > "$PID_FILE"
echo "dwoj 已在后台启动 (pid $!)，日志目录：$LOG_DIR"
