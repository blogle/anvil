import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
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

type NixDaemonProcess = {
  exited: Promise<number>;
  kill: (signal?: number | NodeJS.Signals) => void;
};

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

async function preflight(
  storeUri: string,
  mountedStoreRoot: string,
  manifest: string,
  temporaryDirectory: string,
  home: string,
) {
  return run(
    workerPreflightExecutable,
    [storeUri, manifest, mountedStoreRoot, nixExecutablePath],
    {
      HOME: home,
      PATH: dirname(nixExecutablePath),
      TMPDIR: temporaryDirectory,
      NIX_CONFIG: "",
      NIX_PATH: "",
    },
  );
}

async function nixDaemonStoreInfo(
  storeUri: string,
  home: string,
): Promise<string> {
  const result = await nix(["store", "info", "--store", storeUri], home);
  assert(
    result.exitCode === 0,
    `temporary Nix daemon store is not reachable at ${storeUri}: ${result.stderr}`,
  );
  return `${result.stdout}\n${result.stderr}`;
}

async function waitForSocket(
  child: NixDaemonProcess,
  socketPath: string,
  stderr: Promise<string>,
): Promise<void> {
  let exitCode: number | undefined;
  void child.exited.then((code) => (exitCode = code));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if (lstatSync(socketPath).isSocket()) return;
    } catch {
      // The listener may not have created its socket yet.
    }
    if (exitCode !== undefined) break;
    await Bun.sleep(50);
  }
  await stopDaemon(child);
  throw new Error(
    `temporary unprivileged Nix daemon did not bind ${socketPath} (exit ${exitCode}; stderr: ${await stderr})`,
  );
}

async function stopDaemon(child: NixDaemonProcess): Promise<void> {
  let exited = false;
  const exit = child.exited.then((code) => {
    exited = true;
    return code;
  });
  child.kill("SIGTERM");
  await Promise.race([exit, Bun.sleep(3_000)]);
  if (!exited) child.kill("SIGKILL");
  await exit;
}

function makeReadOnly(path: string): void {
  const details = lstatSync(path);
  if (details.isSymbolicLink()) return;
  if (details.isDirectory()) {
    for (const child of readdirSync(path)) makeReadOnly(join(path, child));
  }
  chmodSync(path, details.mode & 0o7777 & ~0o222);
}

function assertNotWritable(path: string): void {
  const writeProbe = join(path, ".anvil-preflight-write-probe");
  try {
    writeFileSync(writeProbe, "unexpected write access");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    assert(
      code === "EACCES" || code === "EPERM",
      `mounted store write failed for an unexpected reason: ${String(error)}`,
    );
    return;
  }
  rmSync(writeProbe, { force: true });
  throw new Error("unprivileged client can write into the mounted store");
}

async function proveUnixSocketDaemon(
  isolatedRoot: string,
  temporaryDirectory: string,
  temporaryHome: string,
  openCodeStorePath: string,
): Promise<void> {
  assert(
    process.getuid?.() === 1000,
    `Unix-socket proof requires image UID 1000; actual UID is ${process.getuid?.() ?? "unavailable"}`,
  );
  const socketPath = join(isolatedRoot, "nix-daemon.sock");
  const socketStoreUri = `unix://${socketPath}`;
  const daemonBackendRoot = join(isolatedRoot, "daemon-backend");
  const daemonBackendStoreRoot = join(daemonBackendRoot, "nix", "store");
  const matchingMountRoot = join(isolatedRoot, "socket-mounted-matching");
  const emptyMountRoot = join(isolatedRoot, "socket-mounted-empty");
  const corruptMountRoot = join(isolatedRoot, "socket-mounted-corrupt");
  for (const directory of [matchingMountRoot, emptyMountRoot, corruptMountRoot])
    mkdirSync(directory, { recursive: true });

  const daemon = Bun.spawn([nixExecutablePath, "daemon"], {
    env: {
      HOME: temporaryHome,
      PATH: dirname(nixExecutablePath),
      NIX_CONFIG: `store = local?root=${daemonBackendRoot}&require-sigs=false`,
      NIX_DAEMON_SOCKET_PATH: socketPath,
      NIX_PATH: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const daemonStdout = new Response(daemon.stdout).text();
  const daemonStderr = new Response(daemon.stderr).text();
  try {
    await waitForSocket(daemon, socketPath, daemonStderr);
    const storeInfo = await nixDaemonStoreInfo(socketStoreUri, temporaryHome);
    assert(
      storeInfo.includes("Trusted: 0"),
      `temporary daemon did not identify its UID-1000 client as untrusted (output: ${storeInfo})`,
    );
    console.log(
      "PASS UNIX-DAEMON UNTRUSTED CLIENT: temporary Nix 2.34.9 daemon reports Trusted: 0 for UID 1000",
    );

    const seeded = await nix(
      [
        "copy",
        "--no-check-sigs",
        "--from",
        "daemon",
        "--to",
        socketStoreUri,
        workerImagePath,
      ],
      temporaryHome,
    );
    assert(
      seeded.exitCode === 0,
      `copying the image closure into the temporary daemon backend failed: ${seeded.stderr}`,
    );

    const exactMountedPaths = runtimePaths.filter((path) =>
      imageClosurePaths.includes(path),
    );
    copyRuntimePaths(
      daemonBackendStoreRoot,
      matchingMountRoot,
      exactMountedPaths,
    );
    copyRuntimePaths(
      daemonBackendStoreRoot,
      corruptMountRoot,
      exactMountedPaths,
    );
    const emptyMountResult = await preflight(
      socketStoreUri,
      emptyMountRoot,
      runtimeManifestPath,
      temporaryDirectory,
      temporaryHome,
    );
    assert(
      emptyMountResult.exitCode !== 0 &&
        emptyMountResult.stderr.includes(
          "BLOCKED: mounted shared store is missing",
        ),
      "healthy seeded Unix daemon accepted an empty distinct mounted store",
    );
    console.log(
      "PASS UNIX-DAEMON EMPTY-MOUNT NEGATIVE: healthy daemon rejects empty mounted store",
    );

    corruptOpenCodePath(corruptMountRoot, openCodeStorePath);
    for (const path of [matchingMountRoot, corruptMountRoot])
      makeReadOnly(path);
    assertNotWritable(matchingMountRoot);
    console.log(
      "PASS READ-ONLY MOUNT: UID 1000 cannot create files in mounted closure",
    );

    const corruptMountResult = await preflight(
      socketStoreUri,
      corruptMountRoot,
      runtimeManifestPath,
      temporaryDirectory,
      temporaryHome,
    );
    assert(
      corruptMountResult.exitCode !== 0 &&
        corruptMountResult.stderr.includes(
          `BLOCKED: mounted bytes do not match daemon NAR hash for ${basename(openCodeStorePath)}`,
        ),
      "healthy Unix daemon accepted same-name tampered mounted OpenCode bytes",
    );
    console.log(
      "PASS UNIX-DAEMON CORRUPTION NEGATIVE: healthy daemon rejects tampered distinct mount",
    );

    const matchedMountResult = await preflight(
      socketStoreUri,
      matchingMountRoot,
      runtimeManifestPath,
      temporaryDirectory,
      temporaryHome,
    );
    assert(
      matchedMountResult.exitCode === 0 &&
        matchedMountResult.stdout.includes("shared-store preflight passed"),
      `actual preflight rejected matching read-only mount via Unix daemon: ${matchedMountResult.stderr}`,
    );
    console.log(
      `PASS UNIX-DAEMON MATCHED-MOUNT: actual packaged preflight NAR-verified ${runtimePaths.length} paths over ${socketStoreUri}`,
    );

    const missingSocketUri = `unix://${join(isolatedRoot, "missing-nix-daemon.sock")}`;
    const missingSocketResult = await preflight(
      missingSocketUri,
      matchingMountRoot,
      runtimeManifestPath,
      temporaryDirectory,
      temporaryHome,
    );
    assert(
      missingSocketResult.exitCode !== 0 &&
        missingSocketResult.stderr.includes(
          "BLOCKED: required worker closure paths are missing or unregistered",
        ),
      "preflight did not fail closed when the Unix daemon socket path was missing",
    );
    console.log(
      "PASS UNIX-DAEMON MISSING-SOCKET NEGATIVE: actual preflight fails closed",
    );
  } finally {
    await stopDaemon(daemon);
    await daemonStdout;
    await daemonStderr;
  }

  const closedSocketResult = await preflight(
    socketStoreUri,
    matchingMountRoot,
    runtimeManifestPath,
    temporaryDirectory,
    temporaryHome,
  );
  assert(
    closedSocketResult.exitCode !== 0 &&
      closedSocketResult.stderr.includes(
        "BLOCKED: required worker closure paths are missing or unregistered",
      ),
    "preflight did not fail closed when the temporary daemon was stopped",
  );
  console.log(
    "PASS UNIX-DAEMON CLOSED-SOCKET NEGATIVE: stopped daemon fails closed",
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

function copyRuntimePaths(
  sourceStoreRoot: string,
  mountedStoreRoot: string,
  runtimePaths: readonly string[],
): void {
  for (const storePath of runtimePaths)
    cpSync(
      join(sourceStoreRoot, basename(storePath)),
      join(mountedStoreRoot, basename(storePath)),
      { recursive: true, verbatimSymlinks: true, preserveTimestamps: true },
    );
}

function corruptOpenCodePath(
  mountedStoreRoot: string,
  openCodeStorePath: string,
): void {
  const executable = join(
    mountedStoreRoot,
    basename(openCodeStorePath),
    "bin",
    "opencode",
  );
  const mode = statSync(executable).mode & 0o7777;
  chmodSync(executable, mode | 0o200);
  writeFileSync(executable, "split-brain corrupt OpenCode bytes");
  chmodSync(executable, mode);
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
const openCodePath = runtimePaths.find((path) =>
  path.includes("opencode-2.0.32"),
);
if (openCodePath === undefined)
  throw new Error("worker runtime manifest does not contain OpenCode");

const isolatedRoot = mkdtempSync(join(tmpdir(), "anvil-worker-store-seed-"));
const temporaryDirectory = join(isolatedRoot, "tmp");
const temporaryHome = join(isolatedRoot, "home");
const daemonRoot = join(isolatedRoot, "daemon-store");
const daemonStore = `local?root=${daemonRoot}`;
const daemonStoreRoot = join(daemonRoot, "nix", "store");
const emptyMountRoot = join(isolatedRoot, "mounted-empty");
const wrongMountRoot = join(isolatedRoot, "mounted-wrong", "nix", "store");
const correctMountRoot = join(isolatedRoot, "mounted-correct", "nix", "store");
for (const directory of [
  temporaryDirectory,
  temporaryHome,
  emptyMountRoot,
  wrongMountRoot,
  correctMountRoot,
])
  mkdirSync(directory, { recursive: true });

try {
  const unseededDaemonPreflight = await preflight(
    daemonStore,
    emptyMountRoot,
    runtimeManifestPath,
    temporaryDirectory,
    temporaryHome,
  );
  assert(
    unseededDaemonPreflight.exitCode !== 0 &&
      unseededDaemonPreflight.stderr.includes("BLOCKED:"),
    "preflight did not fail closed for an unseeded Nix daemon store",
  );
  console.log(
    "PASS UNSEEDED-DAEMON NEGATIVE: preflight rejects store A before registration",
  );

  const seedDaemonStore = await nix(
    ["copy", "--no-check-sigs", "--to", daemonStore, workerImagePath],
    temporaryHome,
  );
  assert(
    seedDaemonStore.exitCode === 0,
    `seeding registered store A failed: ${seedDaemonStore.stderr}`,
  );
  const verifiedDaemonStore = await nix(
    [
      "store",
      "verify",
      "--store",
      daemonStore,
      "--no-trust",
      "--recursive",
      workerImagePath,
    ],
    temporaryHome,
  );
  assert(
    verifiedDaemonStore.exitCode === 0,
    `seeded store A failed Nix content verification: ${verifiedDaemonStore.stderr}`,
  );

  const incompleteManifest = join(isolatedRoot, "incomplete-closure.paths");
  writeFileSync(
    incompleteManifest,
    `${runtimePaths.slice(0, -1).join("\n")}\n`,
  );
  const wrongManifestPreflight = await preflight(
    daemonStore,
    emptyMountRoot,
    incompleteManifest,
    temporaryDirectory,
    temporaryHome,
  );
  assert(
    wrongManifestPreflight.exitCode !== 0 &&
      wrongManifestPreflight.stderr.includes(
        "BLOCKED: worker closure manifest does not match the image-pinned digest",
      ),
    "preflight accepted an altered image-closure manifest",
  );
  console.log(
    "PASS WRONG-MANIFEST NEGATIVE: preflight rejects an incomplete closure list",
  );

  const emptyMountPreflight = await preflight(
    daemonStore,
    emptyMountRoot,
    runtimeManifestPath,
    temporaryDirectory,
    temporaryHome,
  );
  assert(
    emptyMountPreflight.exitCode !== 0 &&
      emptyMountPreflight.stderr.includes(
        "BLOCKED: mounted shared store is missing",
      ),
    "seeded/verified store A incorrectly greenlit empty mounted store B",
  );
  console.log(
    "PASS SPLIT-BRAIN EMPTY NEGATIVE: seeded store A rejects empty mount B",
  );

  copyRuntimePaths(daemonStoreRoot, wrongMountRoot, runtimePaths);
  copyRuntimePaths(daemonStoreRoot, correctMountRoot, runtimePaths);
  corruptOpenCodePath(wrongMountRoot, openCodePath);
  const wrongBytesPreflight = await preflight(
    daemonStore,
    wrongMountRoot,
    runtimeManifestPath,
    temporaryDirectory,
    temporaryHome,
  );
  assert(
    wrongBytesPreflight.exitCode !== 0 &&
      wrongBytesPreflight.stderr.includes(
        `BLOCKED: mounted bytes do not match daemon NAR hash for ${basename(openCodePath)}`,
      ),
    "preflight accepted same-name mounted bytes that differ from registered store A",
  );
  console.log(
    "PASS SPLIT-BRAIN CORRUPTION NEGATIVE: daemon store A rejects tampered OpenCode bytes in mount B",
  );

  const correctMountPreflight = await preflight(
    daemonStore,
    correctMountRoot,
    runtimeManifestPath,
    temporaryDirectory,
    temporaryHome,
  );
  assert(
    correctMountPreflight.exitCode === 0 &&
      correctMountPreflight.stdout.includes("shared-store preflight passed"),
    `preflight rejected mount B with matching NAR bytes: ${correctMountPreflight.stderr}`,
  );
  console.log(
    `PASS MATCHED-MOUNT POSITIVE: all ${runtimePaths.length} NAR-verified mounted runtime paths match registered store A`,
  );
  await proveUnixSocketDaemon(
    isolatedRoot,
    temporaryDirectory,
    temporaryHome,
    openCodePath,
  );
} finally {
  makeWritableForCleanup(isolatedRoot);
  rmSync(isolatedRoot, { recursive: true, force: true });
}
