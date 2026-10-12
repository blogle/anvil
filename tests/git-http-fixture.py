#!/usr/bin/env python3
"""Tiny HTTPS Git smart-HTTP fixture for the local executor E2E."""

import os
import ssl
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit


root, certificate, key, port = sys.argv[1:]


class GitHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.run_backend()

    def do_POST(self):
        self.run_backend()

    def run_backend(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        parsed = urlsplit(self.path)
        environment = os.environ.copy()
        environment.update(
            {
                "GIT_PROJECT_ROOT": root,
                "GIT_HTTP_EXPORT_ALL": "1",
                "PATH_INFO": parsed.path,
                "QUERY_STRING": parsed.query,
                "REQUEST_METHOD": self.command,
                "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                "CONTENT_LENGTH": str(len(body)),
                "REMOTE_USER": "",
                "REMOTE_ADDR": self.client_address[0],
                "SERVER_PROTOCOL": self.request_version,
                "HTTP_GIT_PROTOCOL": self.headers.get("Git-Protocol", ""),
            }
        )
        result = subprocess.run(
            ["git", "http-backend"], input=body, capture_output=True, env=environment
        )
        headers, separator, payload = result.stdout.partition(b"\r\n\r\n")
        if not separator:
            self.send_error(500, "git http-backend returned malformed CGI output")
            return
        status = 200
        response_headers = []
        for line in headers.split(b"\r\n"):
            name, _, value = line.partition(b":")
            if name.lower() == b"status":
                status = int(value.strip().split(b" ", 1)[0])
            elif name:
                response_headers.append((name.decode("ascii"), value.strip().decode("latin1")))
        self.send_response(status)
        for name, value in response_headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, _format, *_args):
        pass


server = HTTPServer(("127.0.0.1", int(port)), GitHandler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(certificate, key)
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
