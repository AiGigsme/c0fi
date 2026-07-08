#!/usr/bin/env python3
"""
mcp_stdio_bridge.py — generic stdio → HTTP adapter for MCP servers

C0fi (and any browser client) speaks MCP over HTTP. Most MCP servers in the
wild — page-agent, filesystem, github, etc. — speak stdio. This bridge spawns
a stdio MCP server as a child process and exposes it at POST /mcp with CORS,
so any of them becomes a C0fi ⚙ Tool Server ingredient.

Zero pip dependencies. Usage:

    python3 mcp_stdio_bridge.py <http_port> -- <command to start stdio MCP server>

Examples:

    # Alibaba page-agent (GUI agent controlling your real browser via its extension)
    LLM_BASE_URL=http://localhost:11435/v1 LLM_MODEL_NAME=qwen3-coder:30b \
        python3 mcp_stdio_bridge.py 8794 -- npx -y @page-agent/mcp

    # Any other stdio MCP server
    python3 mcp_stdio_bridge.py 8795 -- npx -y @modelcontextprotocol/server-filesystem /tmp

Then point a C0fi Tool Server node at  http://localhost:8794/mcp  and discover.
Environment variables pass through to the child process.
"""
import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CALL_TIMEOUT = 600  # seconds — GUI tasks (page-agent) can legitimately take minutes


class StdioChild:
    """Owns the child MCP server process and matches JSON-RPC responses by id."""

    def __init__(self, cmd):
        self.proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=sys.stderr, text=True, bufsize=1,
        )
        self.lock = threading.Lock()
        self.pending = {}   # id -> {"event": Event, "response": dict}
        threading.Thread(target=self._read_loop, daemon=True).start()

    def _read_loop(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                sys.stderr.write(f"[bridge] non-JSON from child: {line[:200]}\n")
                continue
            msg_id = msg.get("id")
            if msg_id is not None and ("result" in msg or "error" in msg):
                with self.lock:
                    slot = self.pending.get(str(msg_id))
                if slot:
                    slot["response"] = msg
                    slot["event"].set()
                    continue
            # server-initiated notification/request — log it, don't crash
            sys.stderr.write(f"[bridge] unmatched from child: {json.dumps(msg)[:300]}\n")

    def send(self, message):
        """Forward a client message. Returns the response dict, or None for notifications."""
        if self.proc.poll() is not None:
            raise RuntimeError("child MCP server has exited")
        msg_id = message.get("id")
        slot = None
        if msg_id is not None:
            slot = {"event": threading.Event(), "response": None}
            with self.lock:
                self.pending[str(msg_id)] = slot
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()
        if slot is None:
            return None
        if not slot["event"].wait(CALL_TIMEOUT):
            with self.lock:
                self.pending.pop(str(msg_id), None)
            raise TimeoutError(f"child did not answer id={msg_id} within {CALL_TIMEOUT}s")
        with self.lock:
            self.pending.pop(str(msg_id), None)
        return slot["response"]


child = None  # set in main
child_cmd_str = ""


class Handler(BaseHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        alive = child is not None and child.proc.poll() is None
        body = json.dumps({
            "mcp": True, "transport": "stdio-bridged-to-http", "endpoint": "POST /mcp",
            "child_command": child_cmd_str, "child_alive": alive,
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            message = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._send(400, {"jsonrpc": "2.0", "id": None,
                                    "error": {"code": -32700, "message": "parse error"}})
        try:
            response = child.send(message)
        except Exception as exc:
            return self._send(200, {"jsonrpc": "2.0", "id": message.get("id"),
                                    "error": {"code": -32000, "message": f"bridge: {exc}"}})
        if response is None:  # notification
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self._send(200, response)

    def _send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("mcp_stdio_bridge: " + fmt % args + "\n")


def main():
    global child, child_cmd_str
    argv = sys.argv[1:]
    if "--" not in argv or len(argv) < 3:
        sys.exit(__doc__)
    sep = argv.index("--")
    port = int(argv[0]) if sep >= 1 else 8794
    cmd = argv[sep + 1:]
    child_cmd_str = " ".join(cmd)

    child = StdioChild(cmd)
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as exc:
        sys.exit(
            f"mcp_stdio_bridge: port {port} is already in use ({exc}).\n"
            f"Don't fight the squatter — pick another port:  python3 mcp_stdio_bridge.py {port + 5} -- {child_cmd_str}"
        )
    print(f"MCP stdio bridge at http://127.0.0.1:{port}/mcp  →  {child_cmd_str}", flush=True)
    try:
        httpd.serve_forever()
    finally:
        child.proc.terminate()


if __name__ == "__main__":
    main()
