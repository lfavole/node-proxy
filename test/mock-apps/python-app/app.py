import os
import sys
import json
from http.server import HTTPServer, BaseHTTPRequestHandler

port = int(os.environ.get("PORT", 8000))

class Handler(BaseHTTPRequestHandler):
    def do_HEAD(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        body = json.dumps({
            "status": "ok",
            "runtime": "python",
            "version": sys.version,
            "port": port
        })
        self.wfile.write(body.encode("utf-8"))

    def log_message(self, format, *args):
        # Silence verbose logging
        pass

if __name__ == "__main__":
    print(f"[Python App] Listening on port {port}...", flush=True)
    server = HTTPServer(("127.0.0.1", port), Handler)
    server.serve_forever()
