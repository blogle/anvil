import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import https from "node:https";

const [root, certificate, key, rawPort] = process.argv.slice(2);
const server = https.createServer(
  { cert: readFileSync(certificate), key: readFileSync(key) },
  (request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const [path, query = ""] = request.url.split("?", 2);
      const backend = spawnSync("git", ["http-backend"], {
        input: Buffer.concat(chunks),
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: path,
          QUERY_STRING: query,
          REQUEST_METHOD: request.method,
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(Buffer.concat(chunks).length),
          REMOTE_USER: "",
          REMOTE_ADDR: request.socket.remoteAddress ?? "127.0.0.1",
          SERVER_PROTOCOL: `HTTP/${request.httpVersion}`,
          HTTP_GIT_PROTOCOL: request.headers["git-protocol"] ?? "",
        },
      });
      const split = backend.stdout.indexOf(Buffer.from("\r\n\r\n"));
      if (backend.status !== 0 || split < 0) {
        response.writeHead(500);
        response.end("git http-backend failed");
        return;
      }
      const headers = backend.stdout.subarray(0, split).toString("latin1");
      let status = 200;
      const responseHeaders = {};
      for (const line of headers.split("\r\n")) {
        const separator = line.indexOf(":");
        if (separator < 0) continue;
        const name = line.slice(0, separator);
        const value = line.slice(separator + 1).trim();
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
        else responseHeaders[name] = value;
      }
      response.writeHead(status, responseHeaders);
      response.end(backend.stdout.subarray(split + 4));
    });
  },
);
server.listen(Number(rawPort), "127.0.0.1");
