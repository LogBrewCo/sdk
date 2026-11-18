"""The app's local backend: GET /checkout answers 200. Writes its port to the file named in argv[1]."""

import http.server
import sys


def answer(handler: http.server.BaseHTTPRequestHandler) -> None:
    handler.send_response(200 if handler.path == "/checkout" else 404)
    handler.send_header("content-length", "2")
    handler.end_headers()
    handler.wfile.write(b"ok")


def stay_quiet(_handler: http.server.BaseHTTPRequestHandler, *_: object) -> None:
    return


# http.server answers a GET request with the handler method named do_GET.
Handler = type("Handler", (http.server.BaseHTTPRequestHandler,), {"do_GET": answer, "log_message": stay_quiet})


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
with open(sys.argv[1], "w", encoding="utf-8") as port:
    port.write(str(server.server_address[1]))
server.serve_forever()
