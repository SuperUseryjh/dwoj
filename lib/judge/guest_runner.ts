/**
 * 客户机（v86 里的 Alpine Linux）内运行的评测脚本。
 * 由 v86 后端在每次评测前写入 9p 共享目录：/mnt/9p/runner.py
 *
 * 用法（shell 会把本进程的 stdout/stderr 重定向到客户机 /tmp，避免污染串口）：
 *   python3 -I /mnt/9p/runner.py <limit_ms> <max_out> <src> <tmp_out> <tmp_err> \
 *       <dst_out> <dst_err> <dst_time>
 *
 * 退出码：
 *   0   正常结束（stdout 已复制到 dst_out）
 *   1   运行时错误（traceback 写入 dst_err）
 *   123 语法错误
 *   124 超时
 *   125 输出超限
 */
export const GUEST_RUNNER = String.raw`import os
import signal
import sys
import time
import traceback

limit_ms = int(sys.argv[1])
max_out = int(sys.argv[2])
src_path = sys.argv[3]
tmp_out = sys.argv[4]
tmp_err = sys.argv[5]
dst_out = sys.argv[6]
dst_err = sys.argv[7]
dst_time = sys.argv[8]

started = time.time() * 1000


def write_time():
    try:
        with open(dst_time, "w") as f:
            f.write(str(int(time.time() * 1000 - started)))
    except Exception:
        pass


def emit_error(text):
    try:
        data = text.encode("utf-8", "replace")[:8192]
        with open(dst_err, "wb") as f:
            f.write(data)
    except Exception:
        pass


def on_alarm(signum, frame):
    write_time()
    os._exit(124)


signal.signal(signal.SIGALRM, on_alarm)
signal.setitimer(signal.ITIMER_REAL, limit_ms / 1000.0)

# shell 已把 fd 1/2 重定向到客户机 /tmp 下的一次性文件，
# 用户代码即使直接 os.write(1, ...) 也不会污染串口。
sys.stdout = os.fdopen(1, "w", buffering=1, errors="replace")
sys.stderr = os.fdopen(2, "w", buffering=1, errors="replace")

rc = 0
try:
    source = open(src_path, "rb").read()
    try:
        code = compile(source, "main.py", "exec")
    except SyntaxError:
        traceback.print_exc()
        rc = 123
    else:
        sys.stdin = open(0)
        try:
            exec(code, {"__name__": "__main__", "__file__": "main.py", "__builtins__": __builtins__})
        except SystemExit as e:
            code_attr = getattr(e, "code", 0)
            rc = 0 if code_attr in (None, 0) else 1
        except BaseException:
            traceback.print_exc()
            rc = 1
except BaseException:
    traceback.print_exc()
    rc = 1
finally:
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass

# 输出长度检查（用户可能绕过 sys.stdout 直接写 fd 1）
try:
    size = os.path.getsize(tmp_out)
except Exception:
    size = 0
if size > max_out:
    rc = 125

if rc in (0, 1, 123):
    try:
        with open(dst_out, "wb") as dst:
            with open(tmp_out, "rb") as src:
                remaining = max_out
                while remaining > 0:
                    chunk = src.read(min(65536, remaining))
                    if not chunk:
                        break
                    dst.write(chunk)
                    remaining -= len(chunk)
    except Exception:
        pass
    try:
        with open(dst_err, "wb") as dst:
            with open(tmp_err, "rb") as src:
                data = src.read(8192)
                dst.write(data)
    except Exception:
        pass

write_time()
os._exit(rc)
`;
