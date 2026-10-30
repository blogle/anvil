import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const [
  nixExecutable,
  imagePath,
  imageClosurePathsFile,
  runtimeManifest,
  preflightExecutable,
] = process.argv.slice(2);
if (
  nixExecutable === undefined ||
  imagePath === undefined ||
  imageClosurePathsFile === undefined ||
  runtimeManifest === undefined ||
  preflightExecutable === undefined
)
  throw new Error(
    "usage: bun prove-sandbox-worker-store-seed.ts NIX IMAGE IMAGE_CLOSURE RUNTIME_MANIFEST PREFLIGHT",
  );
const nixExecutablePath: string = nixExecutable;
const workerImagePath: string = imagePath;
const imageClosurePathFile: string = imageClosurePathsFile;
const runtimeManifestPath: string = runtimeManifest;
const workerPreflightExecutable: string = preflightExecutable;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(
  executable: string,
  arguments_: readonly string[],
  environment: Record<string, string>,
) {
  const child = Bun.spawn([executable, ...arguments_], {
    env: environment,
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

async function nix(arguments_: readonly string[], home: string) {
  return run(nixExecutablePath, ["--offline", ...arguments_], {
    HOME: home,
    PATH: dirname(nixExecutablePath),
    NIX_CONFIG: "",
    NIX_PATH: "",
  });
}

async function runPreflight(
  storeUri: string,
  manifest: string,
  sharedStoreRoot: string,
  temporaryDirectory: string,
  home: string,
) {
  return run(
    workerPreflightExecutable,
    [storeUri, manifest, sharedStoreRoot, nixExecutablePath],
    {
      HOME: home,
      PATH: dirname(nixExecutablePath),
      TMPDIR: temporaryDirectory,
      NIX_CONFIG: "",
      NIX_PATH: "",
    },
  );
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

const runtimePaths = readFileSync(runtimeManifestPath, "utf8")
  .split(/\r?\n/)
  .filter((path) => path.length > 0);
const imageClosurePaths = readFileSync(imageClosurePathFile, "utf8")
  .split(/\r?\n/)
  .filter((path) => path.length > 0);
assert(runtimePaths.length > 0, "worker runtime closure manifest is empty");
assert(imageClosurePaths.length > 0, "worker image closure list is empty");
assert(
  runtimePaths.every((path) => imageClosurePaths.includes(path)),
  "runtime manifest contains paths outside the Nix image closure",
);
for (const required of [
  "opencode-2.0.32",
  "git-minimal-",
  "anvil-opencode-server",
  "bash-",
  "nss-cacert-",
])
  assert(
    runtimePaths.some((path) => path.includes(required)),
    `worker runtime manifest is missing ${required}`,
  );

const isolatedRoot = mkdtempSync(join(tmpdir(), "anvil-worker-store-seed-"));
const temporaryDirectory = join(isolatedRoot, "tmp");
const temporaryHome = join(isolatedRoot, "home");
const sharedStoreRoot = join(isolatedRoot, "nix", "store");
const isolatedStore = `local?root=${isolatedRoot}`;
for (const path of [temporaryDirectory, temporaryHome, sharedStoreRoot])
  mkdirSync(path, { recursive: true });

try {
  const incompleteManifest = join(isolatedRoot, "incomplete-closure.paths");
  writeFileSync(
    incompleteManifest,
    `${runtimePaths.slice(0, -1).join("\n")}\n`,
  );
  const wrongManifestPreflight = await runPreflight(
    isolatedStore,
    incompleteManifest,
    sharedStoreRoot,
    temporaryDirectory,
    temporaryHome,
  );
  assert(
    wrongManifestPreflight.exitCode !== 0 &&
      wrongManifestPreflight.stderr.includes(
        "BLOCKED: worker closure manifest does not match the image-pinned digest",
      ),
    "preflight accepted an incomplete or wrong-image closure manifest",
  );
  console.log(
    "PASS WRONG-MANIFEST NEGATIVE: preflight rejects a modified closure list",
  );

  const emptyStorePreflight = await runPreflight(
    isolatedStore,
    runtimeManifestPath,
    sharedStoreRoot,
    temporaryDirectory,
    temporaryHome,
  );
  assert(
    emptyStorePreflight.exitCode !== 0 &&
      emptyStorePreflight.stderr.includes(
        "BLOCKED: required worker closure paths are missing or unregistered",
      ),
    "empty isolated store was not rejected by the actual Sandbox preflight",
  );
  console.log(
    "PASS EMPTY-STORE NEGATIVE: actual preflight rejects an unseeded store",
  );

  const copied = await nix(
    ["copy", "--no-check-sigs", "--to", isolatedStore, workerImagePath],
    temporaryHome,
  );
  assert(
    copied.exitCode === 0,
    `Nix closure copy into isolated local store failed: ${copied.stderr}`,
  );

  const registered = await nix(
    ["path-info", "--store", isolatedStore, "--recursive", workerImagePath],
    temporaryHome,
  );
  assert(
    registered.exitCode === 0,
    `isolated store did not register the seeded image closure: ${registered.stderr}`,
  );
  const actualPaths = new Set(
    registered.stdout.split(/\r?\n/).filter((path) => path.length > 0),
  );
  const missingPaths = imageClosurePaths.filter(
    (path) => !actualPaths.has(path),
  );
  assert(
    missingPaths.length === 0 && actualPaths.size === imageClosurePaths.length,
    `isolated store image closure mismatch: ${missingPaths.length} missing paths`,
  );

  const verifiedImage = await nix(
    [
      "store",
      "verify",
      "--store",
      isolatedStore,
      "--no-trust",
      "--recursive",
      workerImagePath,
    ],
    temporaryHome,
  );
  assert(
    verifiedImage.exitCode === 0,
    `isolated image closure failed Nix content verification: ${verifiedImage.stderr}`,
  );

  const seededPreflight = await runPreflight(
    isolatedStore,
    runtimeManifestPath,
    sharedStoreRoot,
    temporaryDirectory,
    temporaryHome,
  );
  assert(
    seededPreflight.exitCode === 0 &&
      seededPreflight.stdout.includes("shared-store preflight passed"),
    `actual Sandbox preflight rejected the seeded closure: ${seededPreflight.stderr}`,
  );
  console.log(
    `PASS SEEDED-CLOSURE: actual preflight verified ${runtimePaths.length} runtime paths; all ${actualPaths.size} image paths are registered and content-verified in the isolated Nix store`,
  );
} finally {
  makeWritableForCleanup(isolatedRoot);
  rmSync(isolatedRoot, { recursive: true, force: true });
}
