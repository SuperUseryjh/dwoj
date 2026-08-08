import json
import os
import resource
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("JUDGE_TOKEN", "")
MAX_CONCURRENCY = max(1, int(os.environ.get("JUDGE_MAX_CONCURRENCY", "1")))
EXECUTOR = ThreadPoolExecutor(max_workers=MAX_CONCURRENCY)

def limit_resources():
    resource.setrlimit(resource.RLIMIT_CPU, (3, 3))
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))

def untrusted_environment():
    # Do not give submitted programs service credentials or inherited host settings.
    return {"PATH": "/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8"}

def judge(payload):
    code = payload.get("code")
    input_data = payload.get("input", "")
    timeout_ms = payload.get("timeLimitMs", 1000)
    if not isinstance(code, str) or not isinstance(input_data, str):
        return {"status": "System Error", "error": "Invalid request payload"}
    timeout = min(max(int(timeout_ms), 100), 10000) / 1000
    with tempfile.TemporaryDirectory(dir="/tmp") as workdir:
        source = os.path.join(workdir, "main.cpp")
        binary = os.path.join(workdir, "main")
        with open(source, "w", encoding="utf-8") as file:
            file.write(code)
        try:
            compile_result = subprocess.run(
                ["g++", "-std=c++17", "-O2", "-pipe", source, "-o", binary],
                capture_output=True, text=True, timeout=15, cwd=workdir,
                env=untrusted_environment()
            )
        except subprocess.TimeoutExpired:
            return {"status": "Compile Error", "error": "Compilation timed out"}
        if compile_result.returncode != 0:
            return {"status": "Compile Error", "error": compile_result.stderr[-4000:]}
        try:
            result = subprocess.run(
                [binary], input=input_data, capture_output=True, text=True, timeout=timeout,
                cwd=workdir, preexec_fn=limit_resources, env=untrusted_environment()
            )
        except subprocess.TimeoutExpired:
            return {"status": "Time Limit Exceeded", "error": "Execution exceeded the configured time limit"}
        if result.returncode != 0:
            return {"status": "Runtime Error", "error": result.stderr[-4000:] or ("Exited with code %s" % result.returncode)}
        return {"status": "OK", "output": result.stdout}

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"status": "ok", "maxConcurrency": MAX_CONCURRENCY})
        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/judge":
            self.send_json(404, {"error": "Not found"})
            return
        if not TOKEN or self.headers.get("Authorization") != "Bearer " + TOKEN:
            self.send_json(401, {"error": "Unauthorized"})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size <= 0 or size > 1024 * 1024:
                raise ValueError("Invalid request size")
            payload = json.loads(self.rfile.read(size))
            future = EXECUTOR.submit(judge, payload)
            self.send_json(200, future.result())
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)})
        except Exception as error:
            self.send_json(500, {"status": "System Error", "error": str(error)})

    def send_json(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, _format, *_args):
        pass

ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
