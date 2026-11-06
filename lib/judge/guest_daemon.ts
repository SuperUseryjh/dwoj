/**
 * 客户机（v86 里的 Alpine Linux）常驻评测守护进程。
 *
 * 由 v86 后端在客户机启动后写入 9p 共享目录：/mnt/9p/daemon.py
 * 启动方式：python3 -I /mnt/9p/daemon.py > /tmp/daemon.log 2>&1 &
 *
 * 安全模型（对应 issue #4）：
 *   1. 共享目录 /mnt/9p 只由守护进程（root）读写；用户代码跑在一个 **chroot 沙箱**
 *      `/srv/ojroot` 里，里面根本看不到 /mnt/9p，也就无法读别人的源码/测试数据、
 *      无法伪造 out_/res_/ok_ 结果。
 *   1b. C/C++ 的编译（预处理/编译/汇编/链接）同样在 chroot + nobody 下运行，
 *      只能看到当前 work 目录；产物校验（ELF magic / 大小）后才由 root 放入
 *      root-only 的 /opt/bin 缓存（issue #6：防止 .incbin 读取他人缓存）。
 *   2. chroot 里以 **nobody(65534)** 运行，即使有内核漏洞也不是 root。
 *   3. 每个测试点用**独立的 work 目录**（跑完即删），`/tmp` 也每轮清空，
 *      不会留下跨提交的残留（例如采集答案的 /tmp/answers）。
 *   4. 用户进程放进独立进程组（setsid），超时/结束时整组 SIGKILL，
 *      并设置 RLIMIT_NPROC / RLIMIT_FSIZE 限制 fork 与写盘。
 *   5. 子进程把 SIGCHLD 设为 SIG_IGN（内核自动回收），避免「有子进程退出而父进程
 *      没 waitpid」这种情况触发 v86 的 `Unimplemented: #GP handler` 崩掉宿主进程；
 *      守护进程自身也注册成 subreaper 并主动回收孤儿。
 *   6. 输出通过父进程持有的 fd 读取（不按文件名读），用户即使删掉同名文件也改不了结果。
 *
 * 协议（全部通过 9p 共享目录交换文件；这些文件用户代码都碰不到）：
 *   宿主机写入：sol_<tag>.<ext> / in_<tag>.txt / 空的结果文件，最后写 job_<tag>.json
 *   守护进程写：out_<tag>.txt / err_<tag>.txt / res_<tag>.json，最后写 ok_<tag>
 *   结果 rc：0 正常 / 1 运行时错误 / 123 编译或语法错误 / 124 超时 / 125 输出超限
 */
export const GUEST_DAEMON = String.raw`import json as _json
import os
import resource
import shutil
import signal
import subprocess
import time
import traceback

RES = "/mnt/9p"
OJR = "/srv/ojroot"          # 用户代码看到的“根”，里面没有 /mnt/9p
WORK = OJR + "/work"         # 每个测试点一个子目录
BIN_DIR = OJR + "/opt/bin"   # 编译产物（按提交缓存，仅 root 可访问）
RUN_UID = 65534              # nobody
RUN_GID = 65534
GXX = ["g++", "-O2", "-std=c++17", "-pipe", "-w"]
OK_PREFIX = "ok_"
JOB_PREFIX = "job_"
OWN_PREFIXES = ("sol_", "in_", "out_", "err_", "res_", "job_", "ok_")
MAX_STDERR = 8192
FSIZE_LIMIT = 16 * 1024 * 1024
COMPILE_FSIZE_LIMIT = 64 * 1024 * 1024

# 预热：让这些模块留在常驻进程的内存/页缓存里，fork 出来的子进程直接继承
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


def run_quiet(args, cwd=None, timeout=None):
    return subprocess.run(
        args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout
    )


# ============================================================
# 沙箱根目录：把系统目录 bind 进去，但不包含 /mnt/9p
# ============================================================

def prepare_root():
    os.makedirs(OJR, exist_ok=True)
    for sub in ("/work", "/opt/bin", "/tmp", "/proc", "/sys", "/dev", "/usr", "/lib", "/bin", "/sbin", "/etc"):
        os.makedirs(OJR + sub, exist_ok=True)

    for src in ("/usr", "/lib", "/bin", "/sbin", "/etc", "/dev", "/proc", "/sys"):
        if not os.path.isdir(src):
            continue
        dst = OJR + src
        if os.path.ismount(dst):
            continue
        proc = run_quiet(["mount", "--bind", src, dst])
        if proc.returncode != 0:
            raise RuntimeError(
                "bind mount %s -> %s failed: %s" % (src, dst, proc.stderr.decode("utf-8", "replace")[:200])
            )

    os.chmod(OJR, 0o755)
    # /work 需要可遍历（0711），但用户只能进入自己的 0700/0755 子目录
    os.chmod(WORK, 0o711)
    os.chmod(BIN_DIR, 0o700)
    os.chmod(OJR + "/tmp", 0o1777)


def set_subreaper():
    """让孤儿进程 reparent 到本进程，便于及时回收（避免僵尸堆积）。"""
    try:
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl(36, 1, 0, 0, 0)  # PR_SET_CHILD_SUBREAPER
    except Exception:
        pass


def reap():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def clear_tmp():
    tmp = OJR + "/tmp"
    try:
        for name in os.listdir(tmp):
            path = os.path.join(tmp, name)
            try:
                if os.path.isdir(path) and not os.path.islink(path):
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    os.unlink(path)
            except Exception:
                pass
    except Exception:
        pass


def cleanup_work(current_tag=None):
    """删掉残留的 work 目录（含 input.txt / 源码），避免被后续编译或运行读到。

    守护进程是串行的：当前任务之外不该存在别的 work 目录。
    上次守护进程崩溃时可能留下带隐藏输入的 work/<tag>，编译沙箱能读到它。
    """
    try:
        for name in os.listdir(WORK):
            if current_tag and name == current_tag:
                continue
            shutil.rmtree(os.path.join(WORK, name), ignore_errors=True)
    except Exception:
        pass


def cleanup_previous(current_tag):
    """删掉上一轮遗留的共享目录文件（宿主机已经读完了），避免无限增长。"""
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


# ============================================================
# 编译
# ============================================================

def compile_cpp(work, bin_rel, timeout_ms):
    """
    在 chroot + nobody 下编译，产物校验后才由 root 放进 /opt/bin 缓存。

    issue #6：编译曾以 root 跑在 chroot 外，用户可以用 GCC 的
    .incbin 指令让汇编器读取 root-only 的其他提交缓存（或 /mnt/9p），
    再在降权运行时把字节写出来执行。现在编译器看不到 /mnt/9p、
    也读不到 0700 的缓存目录，只能看到当前 work 目录里的源码。
    """
    tag = os.path.basename(work)
    dst = OJR + bin_rel
    target = os.path.join(work, "prog")

    # 编译进程以 nobody 运行，需要能在自己的 work 目录里写产物
    try:
        os.chown(work, RUN_UID, RUN_GID)
        os.chmod(work, 0o755)
    except Exception:
        pass
    for leftover in (target, os.path.join(work, "compile.out"), os.path.join(work, "compile.err")):
        try:
            os.unlink(leftover)
        except Exception:
            pass

    out_path = os.path.join(work, "compile.out")
    err_path = os.path.join(work, "compile.err")
    try:
        out_fd = os.open(out_path, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o600)
        err_fd = os.open(err_path, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o600)
    except Exception as exc:
        return 123, "编译失败：%s" % exc

    started = time.time()
    pid = os.fork()
    if pid == 0:
        # ---------------- 子进程：chroot + 降权后 exec 编译器 ----------------
        try:
            os.dup2(out_fd, 1)
            os.dup2(err_fd, 2)
            for fd in (out_fd, err_fd):
                if fd > 2:
                    os.close(fd)

            os.setsid()

            try:
                resource.setrlimit(resource.RLIMIT_NPROC, (32, 32))
                resource.setrlimit(resource.RLIMIT_FSIZE, (COMPILE_FSIZE_LIMIT, COMPILE_FSIZE_LIMIT))
                resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            except Exception:
                pass

            os.chroot(OJR)
            os.chdir("/work/" + tag)

            os.setgroups([])
            os.setgid(RUN_GID)
            os.setuid(RUN_UID)

            env = {
                "PATH": "/usr/bin:/bin",
                "HOME": "/tmp",
                "TMPDIR": "/tmp",
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
            }
            os.execvpe(GXX[0], GXX + ["-o", "prog", "main.cpp"], env)
        except BaseException:
            pass
        os._exit(126)

    # ---------------- 父进程：带超时等待，超时杀整个编译进程组 ----------------
    deadline = started + timeout_ms / 1000.0
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
            for killer in (lambda: os.killpg(pid, signal.SIGKILL), lambda: os.kill(pid, signal.SIGKILL)):
                try:
                    killer()
                except Exception:
                    pass
            try:
                os.waitpid(pid, 0)
            except Exception:
                pass
            status = None
            break
        time.sleep(0.005)

    reap()

    err = b""
    try:
        os.lseek(err_fd, 0, os.SEEK_SET)
        err = os.read(err_fd, MAX_STDERR)
    except Exception:
        pass
    for fd in (out_fd, err_fd):
        try:
            os.close(fd)
        except Exception:
            pass

    if status is None:
        return 123, "编译超时（超过 %d ms）" % timeout_ms
    if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
        msg = err.decode("utf-8", "replace").strip()
        if not msg:
            if os.WIFEXITED(status):
                msg = "编译失败（退出码 %d）" % os.WEXITSTATUS(status)
            else:
                msg = "编译进程被信号终止"
        return 123, msg[:MAX_STDERR]

    # ---------------- 校验产物，再交给 root-only 缓存 ----------------
    try:
        st = os.stat(target)
        if not os.path.isfile(target) or st.st_size <= 0 or st.st_size > COMPILE_FSIZE_LIMIT:
            return 123, "编译产物无效"
        with open(target, "rb") as f:
            if f.read(4) != b"\x7fELF":
                return 123, "编译产物不是 ELF 可执行文件"
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        tmp_dst = dst + ".tmp"
        shutil.copyfile(target, tmp_dst)
        os.chmod(tmp_dst, 0o755)
        os.replace(tmp_dst, dst)
    except Exception as exc:
        return 123, "编译产物校验失败：%s" % exc
    return 0, ""


# ============================================================
# 运行（fork → chroot → 降权 → exec/exec 用户代码）
# ============================================================

def run_case(tag, job, work):
    lang = job.get("lang")
    limit = int(job["limit"])
    max_out = int(job["maxOut"])

    # 工作目录给 nobody，方便程序写临时文件；stdout/stderr 由父进程持有 fd，用户改不到
    try:
        os.chown(work, RUN_UID, RUN_GID)
        os.chmod(work, 0o755)
    except Exception:
        pass

    in_fd = os.open(os.path.join(work, "input.txt"), os.O_RDONLY)
    out_fd = os.open(os.path.join(work, "stdout.txt"), os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o600)
    err_fd = os.open(os.path.join(work, "stderr.txt"), os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o600)

    started = time.time()
    pid = os.fork()

    if pid == 0:
        # ---------------- 子进程（不可返回） ----------------
        try:
            os.dup2(in_fd, 0)
            os.dup2(out_fd, 1)
            os.dup2(err_fd, 2)
            for fd in (in_fd, out_fd, err_fd):
                if fd > 2:
                    os.close(fd)

            os.setsid()  # 独立进程组，方便整组杀掉

            try:
                resource.setrlimit(resource.RLIMIT_NPROC, (32, 32))
                resource.setrlimit(resource.RLIMIT_FSIZE, (FSIZE_LIMIT, FSIZE_LIMIT))
            except Exception:
                pass

            os.chroot(OJR)
            os.chdir("/work/" + tag)

            os.setgroups([])
            os.setgid(RUN_GID)
            os.setuid(RUN_UID)

            os.environ.clear()
            os.environ.update({
                "PATH": "/usr/bin:/bin",
                "HOME": "/tmp",
                "TMPDIR": "/tmp",
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
                "PYTHONIOENCODING": "utf-8",
                "PYTHONDONTWRITEBYTECODE": "1",
            })

            # 子进程一律自动回收：规避 v86 在“未 waitpid 的子进程退出”时 panic
            try:
                signal.signal(signal.SIGCHLD, signal.SIG_IGN)
            except Exception:
                pass

            def _alarm(_signum, _frame):
                os._exit(124)

            try:
                signal.signal(signal.SIGALRM, _alarm)
                signal.setitimer(signal.ITIMER_REAL, limit / 1000.0)
            except Exception:
                pass

            if lang == "cpp":
                os.execv("/work/%s/prog" % tag, ["/prog"])

            # ---- Python：直接在 fork 出来的解释器里跑 ----
            rc = 0
            try:
                source = read_bytes("/work/%s/main.py" % tag)
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
                os.fsync(1)
            except Exception:
                pass
            os._exit(rc)
        except BaseException:
            try:
                traceback.print_exc()
            except Exception:
                pass
            os._exit(1)

    # ---------------- 父进程 ----------------
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
            for killer in (lambda: os.killpg(pid, signal.SIGKILL), lambda: os.kill(pid, signal.SIGKILL)):
                try:
                    killer()
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
    reap()

    out = b""
    err = b""
    try:
        os.lseek(out_fd, 0, os.SEEK_SET)
        out = os.read(out_fd, max_out + 1)
    except Exception:
        pass
    try:
        os.lseek(err_fd, 0, os.SEEK_SET)
        err = os.read(err_fd, MAX_STDERR)
    except Exception:
        pass
    for fd in (in_fd, out_fd, err_fd):
        try:
            os.close(fd)
        except Exception:
            pass

    if status is None:
        rc = 124
    elif os.WIFEXITED(status):
        rc = os.WEXITSTATUS(status)
    else:
        rc = 1

    if len(out) > max_out:
        rc = 125
        out = out[:max_out]

    return rc, elapsed, out, err


# ============================================================
# 单个作业
# ============================================================

def handle(tag):
    cleanup_previous(tag)
    cleanup_work(tag)

    job_path = os.path.join(RES, JOB_PREFIX + tag + ".json")
    job = _json.loads(read_bytes(job_path).decode("utf-8"))
    try:
        os.unlink(job_path)
    except Exception:
        pass

    for stale in job.get("rmBins") or []:
        try:
            os.unlink(OJR + stale)
        except Exception:
            pass

    work = os.path.join(WORK, tag)
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work, mode=0o700, exist_ok=True)

    lang = job.get("lang")
    ext = "cpp" if lang == "cpp" else "py"
    shutil.copyfile(os.path.join(RES, job["src"]), os.path.join(work, "main." + ext))
    # 输入先读进内存并从 9p 删除，**等编译结束**才落到 work 目录。
    # 否则用户可以在 C++ 源码里 #include "input.txt"，让编译器的报错
    # 原样带出隐藏测试输入（CE 是公开字段，issue #5 的同类通道）。
    input_data = read_bytes(os.path.join(RES, job["inp"]))
    # 源码/输入已经从共享目录取走，立刻删掉，9p 上只留结果文件
    for name in (job["src"], job["inp"]):
        try:
            os.unlink(os.path.join(RES, name))
        except Exception:
            pass

    rc = 0
    elapsed = 0
    compile_error = ""
    out = b""
    err = b""

    try:
        if lang == "cpp":
            bin_rel = job["bin"]
            if job.get("compile"):
                # 编译成功后 work/prog 已经就位，同时已备份到 root-only 缓存
                rc, compile_error = compile_cpp(work, bin_rel, int(job.get("compileTimeoutMs", 180000)))
            elif rc == 0:
                # 复用缓存：从 root-only 目录硬链接/拷贝到本次 work
                target = os.path.join(work, "prog")
                try:
                    os.link(OJR + bin_rel, target)
                except Exception:
                    shutil.copyfile(OJR + bin_rel, target)
                os.chmod(target, 0o755)

        # Python 的语法错误在父进程里预检，用 compileError 上报（CE）。
        # 不能依赖子进程退出码 123：用户代码可以自己 os._exit(123)，
        # 那样会把 stderr 伪装成编译错误（issue #5）。
        if rc == 0 and lang != "cpp":
            try:
                compile(read_bytes(os.path.join(work, "main.py")), "main.py", "exec")
            except SyntaxError:
                compile_error = traceback.format_exc()[:MAX_STDERR]
                rc = 123

        # 编译完成后再把 stdin 落到 work 目录，编译期不可见
        write_bytes(os.path.join(work, "input.txt"), input_data)

        if rc == 0:
            rc, elapsed, out, err = run_case(tag, job, work)
    except BaseException:
        err = traceback.format_exc()[:MAX_STDERR].encode("utf-8", "replace")
        rc = 1
    finally:
        write_bytes(os.path.join(RES, "out_%s.txt" % tag), out)
        write_bytes(os.path.join(RES, "err_%s.txt" % tag), err)
        result = {"rc": rc, "timeMs": elapsed}
        if compile_error:
            result["compileError"] = compile_error
        write_bytes(os.path.join(RES, "res_%s.json" % tag), _json.dumps(result))
        write_bytes(os.path.join(RES, OK_PREFIX + tag), "1")

        shutil.rmtree(work, ignore_errors=True)
        clear_tmp()
        reap()


def main():
    try:
        set_subreaper()
        prepare_root()
        # 启动时清理上次崩溃留下的 work / tmp（可能含隐藏测试输入）
        cleanup_work()
        clear_tmp()
    except BaseException:
        # 沙箱根目录建不起来就 fail-closed：不接活，让宿主机判定为 System Error
        try:
            write_bytes(os.path.join(RES, "daemon.error"), traceback.format_exc())
        except Exception:
            pass
        raise

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
            reap()
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
