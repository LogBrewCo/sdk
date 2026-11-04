"""The app's local backend: GET /checkout answers 200. Writes its port to the file named in argv[1]."""

import http.server
import sys


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        self.send_response(200 if self.path == "/checkout" else 404)
        self.send_header("content-length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *_: object) -> None:
        return


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
with open(sys.argv[1], "w", encoding="utf-8") as port:
    port.write(str(server.server_address[1]))
server.serve_forever()
