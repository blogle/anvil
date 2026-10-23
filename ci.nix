{ pkgs
, craneLib
, rust
, frontend
, images
, sandbox
, publish
, opencodePackage
, repoRoot
}:

let
  commonArgs = rust.commonArgs;
  fmt = craneLib.cargoFmt (commonArgs // { cargoFmtExtraArgs = "--all"; });
  clippy = craneLib.cargoClippy (commonArgs // {
    cargoArtifacts = rust.ciCargoArtifacts;
    CARGO_PROFILE = "ci";
    cargoClippyExtraArgs = "--workspace --all-targets --all-features -- -D warnings";
  });
  tests = craneLib.cargoTest (commonArgs // {
    cargoArtifacts = rust.ciCargoArtifacts;
    CARGO_PROFILE = "ci";
    cargoExtraArgs = "--workspace";
  });
  frontendDependencies = pkgs.buildNpmPackage {
    pname = "anvil-web-test-dependencies";
    version = "0.1.0";
    src = ./web;
    npmDepsHash = "sha256-jSbL4XIRQbOg6DGmouNpFpiVHE9MNKLJn3Wxzfn0yfk=";
    dontNpmBuild = true;
    installPhase = ''
      mkdir -p "$out/node_modules"
      cp -a node_modules/. "$out/node_modules/"
    '';
  };
  frontendSource = pkgs.lib.cleanSource ./web;
  frontendTests = pkgs.runCommand "anvil-frontend-tests" {
    nativeBuildInputs = [ pkgs.coreutils pkgs.nodejs ];
    src = frontendSource;
    nodeModules = frontendDependencies;
  } ''
    work="$(mktemp -d "$TMPDIR/anvil-web-test.XXXXXX")"
    cp -a "$src/." "$work/"
    chmod u+w "$work"
    ln -s "$nodeModules/node_modules" "$work/node_modules"
    cd "$work"
    node node_modules/tsx/dist/cli.mjs --test files-state.test.js state.test.js
    mkdir -p "$out"
  '';
  staticSource = pkgs.lib.cleanSourceWith {
    src = repoRoot;
    filter = path: type:
      let
        p = toString path;
        dirs = [ "/.github" "/.github/workflows" "/tests" "/nix" "/runtime" "/scripts" "/crates" "/crates/anvild" "/crates/anvild/src" "/k8s" ];
        files = [
          "credential-helper.sh" "manifest-security.sh"
          "nix-daemon-smoke.sh" "sandbox.nix" "nix-deployment-canary"
          "nix-daemon-entrypoint" "anvil-credential" "anvil-session-capability"
          "lib.rs" "release-publish.sh"
        ];
      in (type == "directory" && builtins.any (suffix: pkgs.lib.hasSuffix suffix p) dirs)
        || pkgs.lib.hasInfix "/.github/workflows/" p
        || pkgs.lib.hasInfix "/k8s/" p
        || builtins.elem (builtins.baseNameOf p) files;
  };
  static = pkgs.runCommand "anvil-static-config-checks" {
    nativeBuildInputs = [ pkgs.actionlint pkgs.bash pkgs.jq pkgs.kubectl pkgs.kustomize ];
    src = staticSource;
  } ''
    cd "$src"
    actionlint .github/workflows/*.yml
    bash tests/credential-helper.sh
    bash tests/manifest-security.sh
    kubectl kustomize k8s/overlays/dev >/dev/null
    kubectl kustomize k8s/overlays/kind >/dev/null
    mkdir -p "$out"
  '';
  processHarnessSource = pkgs.lib.cleanSourceWith {
    src = repoRoot;
    filter = path: type:
      let p = toString path;
      in (type == "directory" && builtins.any (suffix: pkgs.lib.hasSuffix suffix p) [ "/tests" "/dev" ])
        || builtins.elem (builtins.baseNameOf p) [ "local-e2e.sh" "git-http-fixture.mjs" "opencode-e2e.jsonc" ];
  };
  processBinaries = pkgs.symlinkJoin {
    name = "anvil-process-test-binaries";
    paths = [
      rust.ciReleaseBinaries.anvild
      rust.ciReleaseBinaries.anvilTestModel
    ];
  };
  processE2E = pkgs.runCommand "anvil-local-process-e2e" {
    nativeBuildInputs = [
      pkgs.bash pkgs.curl pkgs.git pkgs.jq pkgs.nodejs pkgs.openssl opencodePackage
    ];
    src = processHarnessSource;
    anvilBinaries = processBinaries;
    webAssets = frontend;
  } ''
    export ANVIL_REPO_ROOT="$src"
    export ANVIL_PREBUILT_BIN_DIR="$anvilBinaries/bin"
    export ANVIL_WEB_DIR="$webAssets"
    bash "$src/tests/local-e2e.sh"
    mkdir -p "$out"
  '';

  # The product artifacts remain distinct, independently cacheable checks;
  # the stage contract does not wrap them in a synthetic success derivation.
  verify = {
    inherit tests frontend frontendTests;
    process-e2e = processE2E;
    anvil-image = images.anvilImageCi;
    sandbox-image = sandbox.sandboxImage;
    nix-daemon-image = sandbox.daemonImage;
    nix-daemon-upgrade-image = sandbox.daemonUpgradeImage;
  };
  fast = { inherit fmt clippy static; };
in
{
  inherit fast verify publish;
  checks = fast // verify;
}
