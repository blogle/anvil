import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [nixExecutable, imagePath, closurePathsFile] = process.argv.slice(2);
if (
  nixExecutable === undefined ||
  imagePath === undefined ||
  closurePathsFile === undefined
)
  throw new Error(
    "usage: bun prove-sandbox-worker-store-seed.ts NIX IMAGE CLOSURE_PATHS",
  );
const nixExecutablePath: string = nixExecutable;
const workerImagePath: string = imagePath;
const closurePathFile: string = closurePathsFile;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function nix(arguments_: readonly string[]) {
  const child = Bun.spawn([nixExecutablePath, "--offline", ...arguments_], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

function makeWritableForCleanup(path: string): void {
  const details = lstatSync(path);
  if (details.isSymbolicLink()) return;
  if (details.isDirectory()) {
    chmodSync(path, 0o700);
    for (const child of readdirSync(path))
      makeWritableForCleanup(join(path, child));
  } else {
    chmodSync(path, 0o600);
  }
}

const expectedPaths = readFileSync(closurePathFile, "utf8")
  .split(/\r?\n/)
  .filter((path) => path.length > 0);
assert(expectedPaths.length > 0, "worker image closure list is empty");
for (const required of [
  "opencode-2.0.32",
  "git-minimal-",
  "anvil-opencode-server",
  "bash-",
  "nss-cacert-",
])
  assert(
    expectedPaths.some((path) => path.includes(required)),
    `worker image closure is missing required runtime component ${required}`,
  );

const openCodePath = expectedPaths.find((path) =>
  path.includes("opencode-2.0.32"),
);
if (openCodePath === undefined)
  throw new Error("worker image closure has no OpenCode executable package");

const isolatedRoot = mkdtempSync(join(tmpdir(), "anvil-worker-store-seed-"));
const isolatedStore = `local?root=${isolatedRoot}`;
try {
  const unseeded = await nix([
    "path-info",
    "--store",
    isolatedStore,
    openCodePath,
  ]);
  assert(
    unseeded.exitCode !== 0,
    "unseeded isolated store unexpectedly contains the OpenCode runtime",
  );
  console.log(
    "PASS EMPTY-STORE NEGATIVE: OpenCode path is absent before closure seeding",
  );

  const copied = await nix([
    "copy",
    "--no-check-sigs",
    "--to",
    isolatedStore,
    workerImagePath,
  ]);
  assert(
    copied.exitCode === 0,
    `Nix closure copy into isolated local store failed: ${copied.stderr}`,
  );

  const registered = await nix([
    "path-info",
    "--store",
    isolatedStore,
    "--recursive",
    workerImagePath,
  ]);
  assert(
    registered.exitCode === 0,
    `isolated store did not register the seeded image closure: ${registered.stderr}`,
  );
  const actualPaths = new Set(
    registered.stdout.split(/\r?\n/).filter((path) => path.length > 0),
  );
  const missingPaths = expectedPaths.filter((path) => !actualPaths.has(path));
  const unexpectedPaths = [...actualPaths].filter(
    (path) => !expectedPaths.includes(path),
  );
  assert(
    missingPaths.length === 0 && unexpectedPaths.length === 0,
    `isolated store closure mismatch: ${missingPaths.length} missing, ${unexpectedPaths.length} unexpected`,
  );

  const verified = await nix([
    "store",
    "verify",
    "--store",
    isolatedStore,
    "--no-trust",
    "--recursive",
    workerImagePath,
  ]);
  assert(
    verified.exitCode === 0,
    `isolated store contains invalid or unreadable closure paths: ${verified.stderr}`,
  );
  console.log(
    `PASS SEEDED-CLOSURE: ${actualPaths.size} image runtime paths are registered and content-verified in a fresh local Nix store`,
  );
} finally {
  makeWritableForCleanup(isolatedRoot);
  rmSync(isolatedRoot, { recursive: true, force: true });
}
