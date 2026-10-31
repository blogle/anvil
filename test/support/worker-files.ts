import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Production OpenCode 2.0.32 route shapes, real worker filesystem and shell
 * subprocesses. Optional home translation represents a container's mount root. */
export class WorkerFiles {
  readonly commands: string[] = [];
  readonly paths: string[] = [];
  writes = 0;
  lostFinishAck = false;
  failWrite = false;
  sessionExists = true;
  beforeWrite: (() => Promise<void>) | undefined;
  constructor(
    readonly home: string,
    readonly helper: string,
    readonly remoteHome = home,
  ) {
    mkdirSync(join(home, "workspace"), { recursive: true });
  }
  path(value: string): string {
    return value
      .replaceAll(this.remoteHome, this.home)
      .replaceAll("/bin/anvil-git-credential", this.helper);
  }
  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const path = url.pathname.slice(url.pathname.indexOf("/api/"));
    if (path === "/api/info")
      return Response.json({ version: "2.0.32+fixture" });
    if (
      path !== "/api/session/active" &&
      /^\/api\/session\/[^/]+$/.test(path) &&
      request.method === "GET"
    )
      return this.sessionExists
        ? Response.json({ data: { id: path.split("/").at(-1) } })
        : new Response(null, { status: 404 });
    if (path === "/api/shell" && request.method === "POST") {
      const body = (await request.json()) as {
        command: string;
        cwd: string;
        metadata: { phase: string };
      };
      this.commands.push(body.command);
      const child = Bun.spawn(["bash", "-c", this.path(body.command)], {
        cwd: this.path(body.cwd),
        stdout: "pipe",
        stderr: "pipe",
      });
      const exit = await child.exited;
      await new Response(child.stdout).text();
      await new Response(child.stderr).text();
      if (body.metadata.phase === "finish" && this.lostFinishAck) {
        this.lostFinishAck = false;
        return new Response(null, { status: 504 });
      }
      return Response.json({
        data: {
          id: `sh_fixture_${this.commands.length}`,
          status: "exited",
          exit,
        },
      });
    }
    if (path === "/api/experimental/fs/write") {
      await this.beforeWrite?.();
      this.paths.push(url.searchParams.get("path")!);
      if (this.failWrite) return new Response(null, { status: 503 });
      const target = this.path(url.searchParams.get("path")!);
      const bytes = new Uint8Array(await request.arrayBuffer());
      writeFileSync(target, bytes);
      this.writes += 1;
      return Response.json({ data: { path: url.searchParams.get("path") } });
    }
    if (path.startsWith("/api/fs/read/")) {
      const file = this.path(
        join(
          url.searchParams.get("location[directory]")!,
          decodeURIComponent(path.slice("/api/fs/read/".length)),
        ),
      );
      try {
        return new Response(readFileSync(file), {
          headers: { "content-type": "application/octet-stream" },
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    }
    return undefined;
  }
}

export async function gitHttp(
  request: Request,
  root: string,
  allowedRef: string,
  tokens: ReadonlySet<string>,
): Promise<Response> {
  const authorization = request.headers.get("authorization");
  if (
    ![...tokens].some(
      (token) =>
        authorization ===
        `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    )
  )
    return new Response(null, {
      status: 401,
      headers: { "www-authenticate": 'Basic realm="local-worker-fixture"' },
    });
  const url = new URL(request.url);
  const child = Bun.spawn(["git", "http-backend"], {
    env: {
      ...process.env,
      GIT_HTTP_EXPORT_ALL: "1",
      GIT_PROJECT_ROOT: root,
      PATH_INFO: url.pathname.slice("/git".length),
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers.get("content-type") ?? "",
      CONTENT_LENGTH: String((await request.clone().arrayBuffer()).byteLength),
      ANVIL_ALLOWED_GIT_REF: allowedRef,
      REMOTE_USER: "fixture-worker",
      SERVER_PROTOCOL: "HTTP/1.1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await child.stdin.write(new Uint8Array(await request.arrayBuffer()));
  await child.stdin.end();
  const bytes = Buffer.from(await new Response(child.stdout).arrayBuffer());
  await child.exited;
  const boundary = bytes.indexOf("\r\n\r\n");
  if (boundary < 0) throw new Error("Invalid local Git CGI response");
  const headers = new Headers();
  let status = 200;
  for (const line of bytes.subarray(0, boundary).toString().split("\r\n")) {
    const split = line.indexOf(":");
    const name = line.slice(0, split),
      value = line.slice(split + 1).trim();
    if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
    else headers.append(name, value);
  }
  return new Response(bytes.subarray(boundary + 4), { status, headers });
}
