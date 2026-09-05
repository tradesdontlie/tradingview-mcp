#!/usr/bin/env python3
"""Serve public/ for the APEX terminal.

    python3 serve.py [--port 8787]

The baked payloads live at public/api/<name> with no file extension, matching
the paths the frontend fetches. This server labels them application/json;
Response.json() ignores Content-Type anyway, so `python3 -m http.server` from
public/ also works if you would rather not run this.
"""
import argparse, functools, http.server, os, socketserver

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")


class Handler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        rel = os.path.relpath(path, ROOT)
        if rel.startswith("api" + os.sep):
            return "application/json"
        return super().guess_type(path)

    def end_headers(self):
        # The payloads are rewritten in place by each bake; never let a browser
        # serve yesterday's numbers out of its own cache.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            super().log_message(fmt, *args)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    args = ap.parse_args()

    if not os.path.isdir(os.path.join(ROOT, "api")):
        print("warning: public/api/ is empty — run `python3 bake.py` first\n")

    socketserver.TCPServer.allow_request_reuse = True
    handler = functools.partial(Handler, directory=ROOT)
    with socketserver.TCPServer(("127.0.0.1", args.port), handler) as httpd:
        print(f"APEX terminal on http://127.0.0.1:{args.port}/  (ctrl-c to stop)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
