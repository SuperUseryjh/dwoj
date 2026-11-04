/**
 * 客户机（v86 里的 Alpine Linux）常驻评测守护进程。
 *
 * 由 v86 后端在客户机启动后写入 9p 共享目录：/mnt/9p/daemon.py
 * 启动方式：python3 -I /mnt/9p/daemon.py > /tmp/daemon.log 2>&1 &
 *
 * 为什么常驻：模拟器里 python 解释器冷启动要 1~2 秒，而用户程序本身可能只要几毫秒。
 * 守护进程预先 import 好常用模块，之后每个测试点只 fork 一个子进程执行用户代码，
 * 单点开销降到 100ms 量级。
 *
 * 协议（全部通过 9p 共享目录交换文件，串口不参与）：
 *   宿主机写入：sol_<tag>.<ext> / in_<tag>.txt / 空的结果文件，最后写 job_<tag>.json
 *   守护进程跑完后写：out_<tag>.txt / err_<tag>.txt / res_<tag>.json，最后写 ok_<tag>
 *   结果：
 *     rc = 0   正常结束
 *     rc = 1   运行时错误
 *     rc = 123 编译/语法错误
 *     rc = 124 超时
 *     rc = 125 输出超限
 */
export const GUEST_DAEMON = String.raw`import json as _json
import os
import select
import signal
import subprocess
import sys
import time
import traceback

RES = "/mnt/9p"
GXX = ["g++", "-O2", "-std=c++17", "-pipe", "-w"]
OK_PREFIX = "ok_"
JOB_PREFIX = "job_"
OWN_PREFIXES = ("sol_", "in_", "out_", "err_", "res_", "job_", "ok_")

# 预热列表：fork 出来的子进程直接继承这些已导入的模块，
# 避免每个测试点都重新解释一遍标准库（模拟器里慢得离谱）。
PRELOAD = (
    "collections", "itertools", "functools", "heapq", "bisect", "math",
    "random", "string", "re", "json", "decimal", "fractions", "operator",
)


def write_bytes(path, data):
    if isinstance(data, str):
        data = data.encode("utf-8", "replace")
    with open(path, "wb") as f:
        f.write(data)


def read_bytes(path, limit=None):
    with open(path, "rb") as f:
        return f.read() if limit is None else f.read(limit)


def cleanup_previous(current_tag):
    """删掉上一轮遗留的文件（宿主机已经读完了），避免共享目录无限增长。"""
    try:
        for name in os.listdir(RES):
            if not name.startswith(OWN_PREFIXES):
                continue
            if current_tag and current_tag in name:
                continue
            try:
                os.unlink(os.path.join(RES, name))
            except Exception:
                pass
    except Exception:
        pass


def compile_cpp(src_path, bin_path, timeout_ms):
    started = time.time()
    try:
        proc = subprocess.run(
            GXX + [src_path, "-o", bin_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_ms / 1000.0,
        )
    except subprocess.TimeoutExpired:
        return 123, "编译超时（超过 %d ms）" % timeout_ms
    except Exception as exc:
        return 123, "编译失败：%s" % exc
    if proc.returncode != 0:
        msg = proc.stderr.decode("utf-8", "replace")[:8192]
        return 123, msg or ("编译失败（退出码 %d）" % proc.returncode)
    return 0, ""


def run_python(tag, job):
    out_path = os.path.join(RES, "out_%s.txt" % tag)
    err_path = os.path.join(RES, "err_%s.txt" % tag)
    src_path = os.path.join(RES, job["src"])
    in_path = os.path.join(RES, job["inp"])
    limit = int(job["limit"])
    max_out = int(job["maxOut"])
    started = time.time()

    pid = os.fork()
    if pid == 0:
        # ---- 子进程：只跑用户代码，绝不返回 ----
        try:
            out_fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
            err_fd = os.open(err_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
            os.dup2(out_fd, 1)
            os.dup2(err_fd, 2)
            try:
                in_fd = os.open(in_path, os.O_RDONLY)
                os.dup2(in_fd, 0)
            except Exception:
                pass
        except Exception:
            os._exit(1)

        def _alarm(_signum, _frame):
            os._exit(124)

        try:
            signal.signal(signal.SIGALRM, _alarm)
            signal.setitimer(signal.ITIMER_REAL, limit / 1000.0)
        except Exception:
            pass

        rc = 0
        try:
            source = read_bytes(src_path)
            try:
                code = compile(source, "main.py", "exec")
            except SyntaxError:
                traceback.print_exc()
                os._exit(123)
            try:
                exec(code, {"__name__": "__main__", "__file__": "main.py", "__builtins__": __builtins__})
            except SystemExit as exc:
                code_value = getattr(exc, "code", 0)
                rc = 0 if code_value in (None, 0) else 1
            except BaseException:
                traceback.print_exc()
                rc = 1
        except BaseException:
            try:
                traceback.print_exc()
            except Exception:
                pass
            rc = 1

        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:
            pass
        try:
            if os.path.getsize(out_path) > max_out:
                rc = 125
        except Exception:
            pass
        os._exit(rc)

    # ---- 父进程：等子进程退出，超时/失控就强杀 ----
    deadline = time.time() + limit / 1000.0 + 2.0
    status = None
    while True:
        try:
            wpid, st = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            wpid, st = pid, 0
        if wpid == pid:
            status = st
            break
        if time.time() > deadline:
            try:
                os.kill(pid, signal.SIGKILL)
            except Exception:
                pass
            try:
                os.waitpid(pid, 0)
            except Exception:
                pass
            status = None
            break
        time.sleep(0.005)

    elapsed = int((time.time() - started) * 1000)
    if status is None:
        return 124, elapsed
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status), elapsed
    return 1, elapsed


def run_binary(tag, job):
    bin_path = job["bin"]
    out_path = os.path.join(RES, "out_%s.txt" % tag)
    err_path = os.path.join(RES, "err_%s.txt" % tag)
    in_path = os.path.join(RES, job["inp"])
    limit = int(job["limit"])
    max_out = int(job["maxOut"])

    started = time.time()
    stdin_f = open(in_path, "rb")
    try:
        proc = subprocess.Popen([bin_path], stdin=stdin_f, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except Exception as exc:
        stdin_f.close()
        write_bytes(err_path, "无法运行编译产物：%s" % exc)
        return 1, 0

    out_fd = proc.stdout.fileno()
    err_fd = proc.stderr.fileno()
    watched = [out_fd, err_fd]
    out_buf = bytearray()
    err_buf = bytearray()
    deadline = time.time() + limit / 1000.0
    rc = 0

    while watched:
        remaining = deadline - time.time()
        if remaining <= 0:
            rc = 124
            break
        try:
            ready, _, _ = select.select(watched, [], [], remaining)
        except Exception:
            ready = watched
        if not ready and time.time() >= deadline:
            rc = 124
            break
        for fd in ready:
            try:
                chunk = os.read(fd, 65536)
            except Exception:
                chunk = b""
            if not chunk:
                watched.remove(fd)
                continue
            if fd == out_fd:
                out_buf += chunk
                if len(out_buf) > max_out:
                    rc = 125
                    break
            elif len(err_buf) < 8192:
                err_buf += chunk[: 8192 - len(err_buf)]
        if rc:
            break

    if rc in (124, 125):
        try:
            proc.kill()
        except Exception:
            pass
    try:
        proc.wait(timeout=5)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    stdin_f.close()

    if rc == 0:
        code = proc.returncode
        rc = 0 if code == 0 else 1

    elapsed = int((time.time() - started) * 1000)
    write_bytes(out_path, bytes(out_buf[:max_out]))
    write_bytes(err_path, bytes(err_buf))
    return rc, elapsed


def handle(tag):
    cleanup_previous(tag)
    job_path = os.path.join(RES, "job_%s.json" % tag)
    res_path = os.path.join(RES, "res_%s.json" % tag)
    job = _json.loads(read_bytes(job_path).decode("utf-8"))

    # 宿主机交办的旧编译产物清理
    for stale in job.get("rmBins") or []:
        try:
            os.unlink(stale)
        except Exception:
            pass

    rc = 0
    elapsed = 0
    compile_error = ""

    if job.get("lang") == "cpp" and job.get("compile"):
        rc, compile_error = compile_cpp(
            os.path.join(RES, job["src"]),
            job["bin"],
            int(job.get("compileTimeoutMs", 180000)),
        )
        elapsed = 0

    if rc == 0:
        try:
            if job.get("lang") == "cpp":
                rc, elapsed = run_binary(tag, job)
            else:
                rc, elapsed = run_python(tag, job)
        except BaseException:
            try:
                write_bytes(os.path.join(RES, "err_%s.txt" % tag), traceback.format_exc()[:8192])
            except Exception:
                pass
            rc, elapsed = 1, 0

    result = {"rc": rc, "timeMs": elapsed}
    if compile_error:
        result["compileError"] = compile_error
    write_bytes(res_path, _json.dumps(result))
    write_bytes(os.path.join(RES, OK_PREFIX + tag), "1")


def main():
    # 先报就绪，再做耗时的标准库预热（宿主机看到 ready 才会发任务，
    # 但任务要等预热结束才会被处理，顺序由主循环保证）
    write_bytes(os.path.join(RES, "daemon.ready"), str(os.getpid()))
    for name in PRELOAD:
        try:
            __import__(name)
        except Exception:
            pass

    while True:
        try:
            names = os.listdir(RES)
        except Exception:
            time.sleep(0.05)
            continue

        jobs = sorted(n for n in names if n.startswith(JOB_PREFIX) and n.endswith(".json"))
        if not jobs:
            time.sleep(0.025)
            continue

        for name in jobs:
            tag = name[len(JOB_PREFIX):-len(".json")]
            try:
                handle(tag)
            except BaseException:
                try:
                    write_bytes(
                        os.path.join(RES, "res_%s.json" % tag),
                        _json.dumps({"rc": 1, "timeMs": 0, "err": "daemon error"}),
                    )
                    write_bytes(os.path.join(RES, OK_PREFIX + tag), "1")
                except Exception:
                    pass
            finally:
                try:
                    os.unlink(os.path.join(RES, name))
                except Exception:
                    pass


if __name__ == "__main__":
    main()
`;
