from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a loopback fake intake for JavaScript release-artifact upload smokes.",
    )
    parser.add_argument("--port-file", required=True)
    parser.add_argument("--state-file", required=True)
    parser.add_argument("--expected-bearer", required=True)
    parser.add_argument("--source-sentinel", required=True)
    parser.add_argument("--query-placeholder", required=True)
    parser.add_argument("--hash-fragment", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    port_file = Path(args.port_file)
    state_file = Path(args.state_file)
    state: dict[str, list[dict[str, object]]] = {"events": []}

    def write_state() -> None:
        state_file.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args: object) -> None:
            return

        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            auth = self.headers.get("Authorization", "")
            route = self.path.split("?", 1)[0]
            event = {
                "path": route,
                "authorized": auth == f"Bearer {args.expected_bearer}",
                "bodyLength": len(body),
                "containsManifest": b"javascript_source_map_manifest" in body,
                "containsSourceSentinel": args.source_sentinel.encode("utf-8") in body,
                "containsAuthValue": args.expected_bearer.encode("utf-8") in body,
                "containsQueryPlaceholder": args.query_placeholder.encode("utf-8") in body,
                "containsHashFragment": args.hash_fragment.encode("utf-8") in body,
                "containsTempPath": str(state_file.parent).encode("utf-8") in body,
                "containsSourceMapPart": b'name="source_map_0"' in body,
                "containsMinifiedPart": b'name="minified_source_0"' in body,
            }
            state["events"].append(event)
            write_state()

            if route == "/retry-success":
                if not event["authorized"]:
                    self.send_response(401)
                elif sum(1 for seen in state["events"] if seen["path"] == "/retry-success") == 1:
                    self.send_response(503)
                else:
                    self.send_response(202)
            else:
                self.send_response(404)
            self.end_headers()
            self.wfile.write(b"{}")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port_file.write_text(str(server.server_address[1]), encoding="utf-8")
    write_state()
    server.serve_forever()


if __name__ == "__main__":
    main()
