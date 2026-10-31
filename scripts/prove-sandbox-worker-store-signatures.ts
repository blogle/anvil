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

const [nixExecutable, runtimePathsFile, runtimeManifest, preflightExecutable] =
  process.argv.slice(2);
if (
  nixExecutable === undefined ||
  runtimePathsFile === undefined ||
  runtimeManifest === undefined ||
  preflightExecutable === undefined
)
  throw new Error(
    "usage: prove-sandbox-worker-store-signatures.ts NIX RUNTIME_PATHS RUNTIME_MANIFEST PREFLIGHT",
  );
const nixExecutablePath: string = nixExecutable;
const runtimePathsFilePath: string = runtimePathsFile;
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
  input?: string,
) {
  const child = Bun.spawn([executable, ...arguments_], {
    env: environment,
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined) {
    const stdin = child.stdin;
    if (stdin === undefined)
      throw new Error("Nix command stdin pipe was not created");
    stdin.write(input);
    stdin.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

function clientEnvironment(home: string): Record<string, string> {
  return {
    HOME: home,
    PATH: dirname(nixExecutablePath),
    NIX_CONFIG: "",
    NIX_PATH: "",
  };
}

async function nix(
  arguments_: readonly string[],
  home: string,
  input?: string,
) {
  return run(
    nixExecutablePath,
    ["--offline", ...arguments_],
    clientEnvironment(home),
    input,
  );
}

async function preflight(
  storeUri: string,
  mountedStoreRoot: string,
  temporaryDirectory: string,
  home: string,
) {
  return run(
    workerPreflightExecutable,
    [storeUri, runtimeManifestPath, mountedStoreRoot, nixExecutablePath],
    {
      ...clientEnvironment(home),
      TMPDIR: temporaryDirectory,
    },
  );
}

async function waitForSocket(
  daemon: NixDaemonProcess,
  socketPath: string,
  stderr: Promise<string>,
): Promise<void> {
  let exitCode: number | undefined;
  void daemon.exited.then((code) => (exitCode = code));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if (lstatSync(socketPath).isSocket()) return;
    } catch {
      // The socket is created asynchronously by nix daemon.
    }
    if (exitCode !== undefined) break;
    await Bun.sleep(50);
  }
  await stopDaemon(daemon);
  throw new Error(
    `temporary Nix daemon did not bind its Unix socket (exit ${exitCode}; stderr: ${await stderr})`,
  );
}

async function stopDaemon(daemon: NixDaemonProcess): Promise<void> {
  let exited = false;
  const exit = daemon.exited.then((code) => {
    exited = true;
    return code;
  });
  daemon.kill("SIGTERM");
  await Promise.race([exit, Bun.sleep(3_000)]);
  if (!exited) daemon.kill("SIGKILL");
  await exit;
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

function makeReadOnly(path: string): void {
  const details = lstatSync(path);
  if (details.isSymbolicLink()) return;
  if (details.isDirectory()) {
    for (const child of readdirSync(path)) makeReadOnly(join(path, child));
  }
  chmodSync(path, details.mode & 0o7777 & ~0o222);
}

function assertNotWritable(path: string): void {
  const writeProbe = join(path, ".signature-proof-write-probe");
  try {
    writeFileSync(writeProbe, "unexpected write access");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    assert(
      code === "EACCES" || code === "EPERM",
      `mounted-store write failed for an unexpected reason: ${String(error)}`,
    );
    return;
  }
  rmSync(writeProbe, { force: true });
  throw new Error("UID-1000 client can write into the mounted closure");
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

const runtimePaths = readFileSync(runtimePathsFilePath, "utf8")
  .split(/\r?\n/)
  .filter((path) => path.length > 0);
const pinnedManifestPaths = readFileSync(runtimeManifestPath, "utf8")
  .split(/\r?\n/)
  .filter((path) => path.length > 0);
assert(runtimePaths.length > 0, "image runtime closure paths file is empty");
assert(
  runtimePaths.length === pinnedManifestPaths.length &&
    runtimePaths.every((path, index) => path === pinnedManifestPaths[index]),
  "runtime closure paths differ from the image-pinned preflight manifest",
);
const bashStorePath = runtimePaths.find((path) => /-bash-[^/]+$/.test(path));
if (bashStorePath === undefined)
  throw new Error(
    "image runtime closure does not include Bash for the probe derivation",
  );
assert(
  process.getuid?.() === 1000,
  `signature proof requires image UID 1000; actual UID is ${process.getuid?.() ?? "unavailable"}`,
);

const isolatedRoot = mkdtempSync(join(tmpdir(), "anvil-worker-signatures-"));
const temporaryHome = join(isolatedRoot, "home");
const temporaryDirectory = join(isolatedRoot, "tmp");
const sourceRoot = join(isolatedRoot, "source-store");
const sourceStoreUri = `local?root=${sourceRoot}&require-sigs=false`;
const sourceStoreRoot = join(sourceRoot, "nix", "store");
const privateKeyPath = join(isolatedRoot, "ephemeral-signing-key");
const mountedStoreRoot = join(isolatedRoot, "mounted-runtime-store");
mkdirSync(temporaryHome, { recursive: true });
mkdirSync(temporaryDirectory, { recursive: true });
mkdirSync(mountedStoreRoot, { recursive: true });

try {
  const copyIntoSource = await nix(
    [
      "copy",
      "--no-check-sigs",
      "--from",
      "daemon",
      "--to",
      sourceStoreUri,
      ...runtimePaths,
    ],
    temporaryHome,
  );
  assert(
    copyIntoSource.exitCode === 0,
    `copying the pinned runtime closure into its isolated source store failed: ${copyIntoSource.stderr}`,
  );
  const sourcePaths = await nix(
    ["path-info", "--store", sourceStoreUri, "--recursive", ...runtimePaths],
    temporaryHome,
  );
  assert(
    sourcePaths.exitCode === 0,
    `isolated source store does not contain the worker runtime closure: ${sourcePaths.stderr}`,
  );
  const sourcePathSet = new Set(sourcePaths.stdout.split(/\r?\n/));
  assert(
    runtimePaths.every((path) => sourcePathSet.has(path)),
    "isolated source store is missing one or more image-pinned runtime paths",
  );
  assert(
    sourcePathSet.size === runtimePaths.length,
    "isolated source closure contains paths outside the pinned runtime manifest",
  );
  const sourcePathInfo = await nix(
    [
      "path-info",
      "--store",
      sourceStoreUri,
      "--json",
      "--json-format",
      "1",
      ...runtimePaths,
    ],
    temporaryHome,
  );
  assert(
    sourcePathInfo.exitCode === 0,
    `could not inspect source runtime signatures: ${sourcePathInfo.stderr}`,
  );
  const sourcePathInfoByPath = JSON.parse(sourcePathInfo.stdout) as Record<
    string,
    { signatures?: readonly string[] }
  >;
  const unsignedRuntimePaths = runtimePaths.filter(
    (path) => sourcePathInfoByPath[path]?.signatures?.length === 0,
  );
  assert(
    unsignedRuntimePaths.length > 0,
    "isolated source copy unexpectedly has no unsigned image runtime paths for the negative test",
  );
  console.log(
    `PASS UNSIGNED SOURCE NEGATIVE FIXTURE: ${basename(unsignedRuntimePaths[0]!)} has no store signatures before the target import`,
  );
  const sourceContents = await nix(
    [
      "store",
      "verify",
      "--store",
      sourceStoreUri,
      "--no-trust",
      "--recursive",
      ...runtimePaths,
    ],
    temporaryHome,
  );
  assert(
    sourceContents.exitCode === 0,
    `isolated source closure failed NAR verification: ${sourceContents.stderr}`,
  );

  const correctKeyName = `anvil-signature-proof-${process.pid}`;
  const wrongKeyName = `anvil-wrong-signature-proof-${process.pid}`;
  const correctSecret = await nix(
    ["key", "generate-secret", "--key-name", correctKeyName],
    temporaryHome,
  );
  const wrongSecret = await nix(
    ["key", "generate-secret", "--key-name", wrongKeyName],
    temporaryHome,
  );
  assert(
    correctSecret.exitCode === 0 && wrongSecret.exitCode === 0,
    "Nix 2.34.9 could not generate ephemeral signing keys",
  );
  writeFileSync(privateKeyPath, `${correctSecret.stdout}\n`, { mode: 0o600 });
  chmodSync(privateKeyPath, 0o600);
  const correctPublic = await nix(
    ["key", "convert-secret-to-public"],
    temporaryHome,
    `${correctSecret.stdout}\n`,
  );
  const wrongPublic = await nix(
    ["key", "convert-secret-to-public"],
    temporaryHome,
    `${wrongSecret.stdout}\n`,
  );
  assert(
    correctPublic.exitCode === 0 && wrongPublic.exitCode === 0,
    "Nix 2.34.9 could not derive the ephemeral public signing keys",
  );
  assert(
    !correctPublic.stdout.includes(":") ||
      correctPublic.stdout.startsWith(`${correctKeyName}:`),
    "Nix derived a public key with an unexpected key name",
  );
  assert(
    !wrongPublic.stdout.includes(":") ||
      wrongPublic.stdout.startsWith(`${wrongKeyName}:`),
    "Nix derived the wrong-key public key with an unexpected key name",
  );
  assert(
    correctPublic.stdout !== wrongPublic.stdout,
    "Nix generated duplicate ephemeral signing keys",
  );
  assert(
    (statSync(privateKeyPath).mode & 0o777) === 0o600,
    "ephemeral private key is not restricted to its owner",
  );

  const derivationExpression = `((builtins.derivation {
    name = "anvil-unsigned-import-probe";
    system = "x86_64-linux";
    builder = ${JSON.stringify(`${bashStorePath}/bin/bash`)};
    args = [ "-c" "mkdir -p $out; printf probe > $out/result" ];
  }).drvPath)`;
  const derivationResult = await nix(
    [
      "eval",
      "--raw",
      "--store",
      sourceStoreUri,
      "--eval-store",
      sourceStoreUri,
      "--expr",
      derivationExpression,
    ],
    temporaryHome,
  );
  assert(
    derivationResult.exitCode === 0 && derivationResult.stdout.endsWith(".drv"),
    `could not create the isolated unsigned derivation: ${derivationResult.stderr}`,
  );
  const arbitraryDerivationPath = derivationResult.stdout;
  const derivationRegistered = await nix(
    ["path-info", "--store", sourceStoreUri, arbitraryDerivationPath],
    temporaryHome,
  );
  assert(
    derivationRegistered.exitCode === 0,
    `unsigned derivation is not registered in the temporary source store: ${derivationRegistered.stderr}`,
  );

  const socketPath = join(isolatedRoot, "nix-daemon.sock");
  const socketStoreUri = `unix://${socketPath}`;
  const targetRoot = join(isolatedRoot, "signature-enforced-target");
  const daemon = Bun.spawn([nixExecutablePath, "daemon"], {
    env: {
      HOME: temporaryHome,
      PATH: dirname(nixExecutablePath),
      NIX_CONFIG: `store = local?root=${targetRoot}&require-sigs=true\ntrusted-public-keys = ${correctPublic.stdout}\nsubstituters =\nsubstitute = false`,
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
    const storeInfo = await nix(
      ["store", "info", "--store", socketStoreUri],
      temporaryHome,
    );
    const storeInfoOutput = `${storeInfo.stdout}\n${storeInfo.stderr}`;
    assert(
      storeInfo.exitCode === 0 && storeInfoOutput.includes("Trusted: 0"),
      `target daemon did not accept the UID-1000 untrusted client: ${storeInfoOutput}`,
    );
    console.log(
      "PASS SIGNATURE DAEMON: Nix 2.34.9 reports Trusted: 0 for UID 1000; target requires signatures",
    );

    const importUnsigned = await nix(
      [
        "copy",
        "--from",
        sourceStoreUri,
        "--to",
        socketStoreUri,
        ...runtimePaths,
      ],
      temporaryHome,
    );
    assert(
      importUnsigned.exitCode !== 0 &&
        importUnsigned.stderr.includes("lacks a signature by a trusted key"),
      `target daemon did not reject the unsigned runtime closure by signature policy (exit ${importUnsigned.exitCode}; stderr: ${importUnsigned.stderr})`,
    );
    console.log(
      "PASS UNSIGNED-CLOSURE NEGATIVE: require-sigs target rejects runtime paths without its trusted signature",
    );

    // Keep the wrong private key under the same private temporary root.
    const wrongPrivateKeyPath = join(
      isolatedRoot,
      "wrong-ephemeral-signing-key",
    );
    writeFileSync(wrongPrivateKeyPath, `${wrongSecret.stdout}\n`, {
      mode: 0o600,
    });
    chmodSync(wrongPrivateKeyPath, 0o600);
    const addWrongSignature = await nix(
      [
        "store",
        "sign",
        "--store",
        sourceStoreUri,
        "--key-file",
        wrongPrivateKeyPath,
        "--recursive",
        ...runtimePaths,
      ],
      temporaryHome,
    );
    assert(
      addWrongSignature.exitCode === 0,
      `adding wrong-key signatures to the isolated source closure failed: ${addWrongSignature.stderr}`,
    );
    const importWrongKey = await nix(
      [
        "copy",
        "--from",
        sourceStoreUri,
        "--to",
        socketStoreUri,
        ...runtimePaths,
      ],
      temporaryHome,
    );
    assert(
      importWrongKey.exitCode !== 0 &&
        importWrongKey.stderr.includes("lacks a signature by a trusted key"),
      `target daemon accepted runtime paths signed only by an untrusted key (exit ${importWrongKey.exitCode}; stderr: ${importWrongKey.stderr})`,
    );
    console.log(
      "PASS WRONG-KEY NEGATIVE: target trusts the configured key only and rejects closure signed with a different ephemeral key",
    );

    const signCorrect = await nix(
      [
        "store",
        "sign",
        "--store",
        sourceStoreUri,
        "--key-file",
        privateKeyPath,
        "--recursive",
        ...runtimePaths,
      ],
      temporaryHome,
    );
    assert(
      signCorrect.exitCode === 0,
      `correct-key source signing failed: ${signCorrect.stderr}`,
    );
    const importSigned = await nix(
      [
        "copy",
        "--from",
        sourceStoreUri,
        "--to",
        socketStoreUri,
        ...runtimePaths,
      ],
      temporaryHome,
    );
    assert(
      importSigned.exitCode === 0,
      `require-sigs target rejected the correctly signed runtime closure: ${importSigned.stderr}`,
    );
    console.log(
      `PASS SIGNED-CLOSURE POSITIVE: UID-1000 untrusted client imported all ${runtimePaths.length} image-pinned runtime paths without --no-check-sigs`,
    );

    const registeredPaths = await nix(
      ["path-info", "--store", socketStoreUri, "--recursive", ...runtimePaths],
      temporaryHome,
    );
    assert(
      registeredPaths.exitCode === 0,
      `signed runtime paths are not registered in the daemon: ${registeredPaths.stderr}`,
    );
    const registeredSet = new Set(registeredPaths.stdout.split(/\r?\n/));
    assert(
      runtimePaths.every((path) => registeredSet.has(path)),
      "signature-enforced daemon omitted one or more pinned runtime paths",
    );
    const verifyTrusted = await nix(
      [
        "--option",
        "trusted-public-keys",
        correctPublic.stdout,
        "store",
        "verify",
        "--store",
        socketStoreUri,
        "--recursive",
        ...runtimePaths,
      ],
      temporaryHome,
    );
    assert(
      verifyTrusted.exitCode === 0,
      `daemon could not verify signed registered runtime content: ${verifyTrusted.stderr}`,
    );

    const targetContents = await nix(
      [
        "store",
        "verify",
        "--store",
        socketStoreUri,
        "--no-trust",
        "--recursive",
        ...runtimePaths,
      ],
      temporaryHome,
    );
    assert(
      targetContents.exitCode === 0,
      `target runtime closure failed daemon-side content verification: ${targetContents.stderr}`,
    );

    copyRuntimePaths(sourceStoreRoot, mountedStoreRoot, runtimePaths);
    makeReadOnly(mountedStoreRoot);
    assertNotWritable(mountedStoreRoot);
    const preflightResult = await preflight(
      socketStoreUri,
      mountedStoreRoot,
      temporaryDirectory,
      temporaryHome,
    );
    assert(
      preflightResult.exitCode === 0 &&
        preflightResult.stdout.includes("shared-store preflight passed"),
      `actual packaged preflight rejected the signed, imported read-only closure: ${preflightResult.stderr}`,
    );
    console.log(
      `PASS SIGNED-PREFLIGHT: actual packaged preflight verified all ${runtimePaths.length} read-only mounted NARs against the signature-enforced Unix daemon`,
    );

    const derivationDescription = await nix(
      [
        "derivation",
        "show",
        "--store",
        sourceStoreUri,
        "--no-pretty",
        arbitraryDerivationPath,
      ],
      temporaryHome,
    );
    assert(
      derivationDescription.exitCode === 0,
      `could not serialize the isolated unsigned derivation: ${derivationDescription.stderr}`,
    );
    const derivationDocument = JSON.parse(derivationDescription.stdout) as {
      version?: unknown;
      derivations?: Record<string, unknown>;
    };
    assert(
      derivationDocument.version === 4 &&
        derivationDocument.derivations !== undefined,
      "Nix 2.34.9 derivation show returned an unexpected JSON document",
    );
    const derivationObjects = Object.values(derivationDocument.derivations);
    assert(
      derivationObjects.length === 1,
      `expected one input-addressed test derivation; received ${derivationObjects.length}`,
    );
    const arbitraryDerivationImport = await nix(
      ["--store", socketStoreUri, "derivation", "add"],
      temporaryHome,
      JSON.stringify(derivationObjects[0]),
    );
    if (arbitraryDerivationImport.exitCode === 0) {
      const targetDerivationPathInfo = await nix(
        ["path-info", "--store", socketStoreUri, arbitraryDerivationPath],
        temporaryHome,
      );
      const targetDerivationVerify = await nix(
        [
          "store",
          "verify",
          "--store",
          socketStoreUri,
          "--recursive",
          arbitraryDerivationPath,
        ],
        temporaryHome,
      );
      assert(
        targetDerivationPathInfo.exitCode === 0,
        `nix derivation add returned success but path-info did not report the derivation as registered (stderr: ${targetDerivationPathInfo.stderr})`,
      );
      assert(
        targetDerivationVerify.exitCode === 4 &&
          targetDerivationVerify.stderr.includes("does not exist"),
        `unexpected verify result for the unsigned derivation registration (exit ${targetDerivationVerify.exitCode}; stderr: ${targetDerivationVerify.stderr})`,
      );
      console.log(
        `BLOCKED/INCOMPATIBLE: require-sigs=true rejects nix copy of unsigned runtime paths, but Nix 2.34.9 derivation add accepted an unsigned derivation from the Trusted: 0 UID-1000 client (path-info exit ${targetDerivationPathInfo.exitCode}; store-verify exit ${targetDerivationVerify.exitCode}; verify stderr: ${targetDerivationVerify.stderr})`,
      );
      throw new Error(
        `untrusted derivation-add operation unexpectedly succeeded (path-info exit ${targetDerivationPathInfo.exitCode}; verify exit ${targetDerivationVerify.exitCode}; stdout: ${arbitraryDerivationImport.stdout}; stderr: ${arbitraryDerivationImport.stderr})`,
      );
    }
    assert(
      arbitraryDerivationImport.stderr.includes(
        "lacks a signature by a trusted key",
      ),
      `unsigned derivation add failed for an unexpected reason: ${arbitraryDerivationImport.stderr}`,
    );
    const targetDerivationPathInfo = await nix(
      ["path-info", "--store", socketStoreUri, arbitraryDerivationPath],
      temporaryHome,
    );
    assert(
      targetDerivationPathInfo.exitCode !== 0,
      "rejected unsigned derivation was nevertheless registered in the target store",
    );
    console.log(
      "PASS UNSIGNED-DERIVATION NEGATIVE: target refuses an arbitrary input-addressed derivation",
    );
  } finally {
    await stopDaemon(daemon);
    await daemonStdout;
    await daemonStderr;
  }
} finally {
  makeWritableForCleanup(isolatedRoot);
  rmSync(isolatedRoot, { recursive: true, force: true });
}
