import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { buildSandboxResource } from "../src/providers/agent-sandbox";

const [imageManifestPath, closurePathsPath, openCodePath, gitPath] =
  process.argv.slice(2);
if (
  imageManifestPath === undefined ||
  closurePathsPath === undefined ||
  openCodePath === undefined ||
  gitPath === undefined
)
  throw new Error(
    "usage: bun check-sandbox-worker-image.ts IMAGE CLOSURE OPENCODE GIT",
  );

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

const manifestText = readFileSync(imageManifestPath, "utf8");
assert(
  manifestText.length > 0,
  "nix2container produced an empty image manifest",
);
const manifest = record(JSON.parse(manifestText));
assert(manifest !== null, "nix2container image manifest is not an object");
const imageConfig = record(manifest["image-config"]);
assert(imageConfig !== null, "OCI image config is missing");
const entrypoint = array(imageConfig["Entrypoint"]);
const imageLayers = array(manifest["layers"]);
assert(
  imageConfig["User"] === "1000:1000" &&
    imageConfig["WorkingDir"] === "/home/anvil/workspace" &&
    entrypoint.length === 1 &&
    typeof entrypoint[0] === "string" &&
    entrypoint[0].includes("anvil-opencode-server") &&
    record(imageConfig["ExposedPorts"])?.["4096/tcp"] !== undefined &&
    imageLayers.length >= 4,
  "OCI config does not define the expected non-root worker, workspace, port, entrypoint, and layers",
);
const entrypointPath = entrypoint[0] as string;
const closurePaths = readFileSync(closurePathsPath, "utf8")
  .split("\n")
  .filter((path) => path.length > 0);
const workerIdentityPath = closurePaths.find((path) =>
  path.includes("anvil-sandbox-worker-identity"),
);
assert(
  workerIdentityPath !== undefined,
  "worker identity rootfs is absent from the image closure",
);
const identityLayerPath = imageLayers
  .flatMap((layerValue) => array(record(layerValue)?.["paths"]))
  .map(record)
  .find((layerPath) => layerPath?.["path"] === workerIdentityPath);
assert(
  identityLayerPath !== undefined &&
    identityLayerPath !== null &&
    record(identityLayerPath["options"])?.["rewrite"] !== undefined,
  "OCI image does not copy the non-root passwd/group identity into its root filesystem",
);
assert(
  readFileSync(join(workerIdentityPath, "etc/passwd"), "utf8").includes(
    "anvil:x:1000:1000:",
  ) &&
    readFileSync(join(workerIdentityPath, "etc/group"), "utf8").includes(
      "anvil:x:1000:",
    ),
  "image rootfs does not define the non-root Anvil worker identity",
);
const entrypointStorePath = entrypointPath.match(/^\/nix\/store\/[^/]+/)?.[0];
assert(
  entrypointStorePath !== undefined,
  "OCI entrypoint is not in the Nix store",
);
for (const requiredPath of [
  openCodePath,
  gitPath,
  entrypointStorePath,
  workerIdentityPath,
])
  assert(
    closurePaths.includes(requiredPath),
    `image closure is missing required runtime path ${basename(requiredPath)}`,
  );
assert(
  closurePaths.some((path) => path.includes("opencode-2.0.32")) &&
    closurePaths.some((path) => path.includes("git-minimal-")),
  "image closure does not include the pinned OpenCode and Git packages",
);
console.log(
  `PASS IMAGE-CONTENT: ${imageLayers.length} OCI layers and closure include OpenCode 2.0.32, Git, and the configured non-root entrypoint`,
);

const resource = buildSandboxResource(
  {
    commissionId: "store-overlay-check",
    project: "store-overlay-check",
    repository: "https://github.com/example/worker",
    baseRef: "main",
    imageDigest: `registry.invalid/worker@sha256:${"a".repeat(64)}`,
    workspaceSize: "1Gi",
    openCodePort: 4096,
    profileClaim: "profile-pvc",
    sharedNixClaim: "shared-nix-pvc",
    environment: {},
    secretReferences: [],
  },
  "sandbox-check",
);
const podSpec = record(
  record(record(resource["spec"])?.["podTemplate"])?.["spec"],
);
assert(podSpec !== null, "current Sandbox resource has no Pod spec");
const containers = array(podSpec["containers"]).map(record);
const sandboxContainer = containers.find(
  (container) => container?.["name"] === "sandbox",
);
assert(
  sandboxContainer !== undefined && sandboxContainer !== null,
  "Sandbox container is missing",
);
const mounts = array(sandboxContainer["volumeMounts"]).map(record);
const sharedStoreMount = mounts.find(
  (mount) => mount?.["mountPath"] === "/nix/store",
);
assert(
  sharedStoreMount?.["name"] === "shared-nix" &&
    sharedStoreMount["subPath"] === "store" &&
    sharedStoreMount["readOnly"] === true,
  "Sandbox spec no longer contains the expected shared-Nix store overlay; review the compatibility gate",
);

const initContainers = array(podSpec["initContainers"]).map(record);
const initPopulatesSharedStore = initContainers.some((container) =>
  array(container?.["volumeMounts"]).some(
    (mountValue) => record(mountValue)?.["name"] === "shared-nix",
  ),
);
assert(
  !initPopulatesSharedStore,
  "Sandbox spec changed to mount shared Nix in init; review whether closure is guaranteed",
);

const runtimeStoreRelativePath = openCodePath.replace(/^\/nix\/store\//, "");
assert(
  runtimeStoreRelativePath !== openCodePath,
  "OpenCode runtime path is not an absolute Nix store path",
);
const overlayRoot = mkdtempSync(join(tmpdir(), "anvil-nix-store-overlay-"));
try {
  const imageStoreRoot = join(overlayRoot, "image-root", "nix", "store");
  const sharedStoreVolume = join(overlayRoot, "shared-nix-volume");
  const bakedExecutable = join(
    imageStoreRoot,
    runtimeStoreRelativePath,
    "bin",
    "opencode",
  );
  const overlaidExecutable = join(
    sharedStoreVolume,
    runtimeStoreRelativePath,
    "bin",
    "opencode",
  );
  mkdirSync(join(imageStoreRoot, runtimeStoreRelativePath, "bin"), {
    recursive: true,
  });
  mkdirSync(sharedStoreVolume, { recursive: true });
  writeFileSync(bakedExecutable, "image-layer OpenCode executable marker");
  assert(
    existsSync(bakedExecutable),
    "adversarial fixture lacks the baked runtime path",
  );
  assert(
    !existsSync(overlaidExecutable),
    "empty shared-store overlay unexpectedly exposes the baked OpenCode path",
  );
  const blockedReason = `BLOCKED/INCOMPATIBLE: current Sandbox mounts shared-nix subPath store over /nix/store, no init contract guarantees ${basename(openCodePath)} exists there, and an empty-volume overlay hides the baked executable`;
  console.log(blockedReason);
  throw new Error(blockedReason);
} finally {
  rmSync(overlayRoot, { recursive: true, force: true });
}
