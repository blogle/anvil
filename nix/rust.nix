{ pkgs, craneLib, opencodePackage, nix2containerPkgs, repoRoot }:

let
  browserFontsConf = pkgs.makeFontsConf {
    fontDirectories = [ pkgs.dejavu_fonts ];
  };
  # Keep the Cargo source filter here so the root flake only wires modules
  # together.  The web application is part of the Rust build input.
  crateFixturePathFilter = path: type:
    let
      sourcePath = toString path;
      isCratesPath = pkgs.lib.hasSuffix "/crates" sourcePath
        || pkgs.lib.hasInfix "/crates/" sourcePath;
      isExcludedPath = builtins.any
        (segment: pkgs.lib.hasInfix "/${segment}/" sourcePath || pkgs.lib.hasSuffix "/${segment}" sourcePath)
        [ ".git" "target" ".cache" "node_modules" ];
    in
    isCratesPath && !isExcludedPath && (
      type == "directory"
      || pkgs.lib.hasSuffix "/fixtures" sourcePath
      || pkgs.lib.hasInfix "/fixtures/" sourcePath
    );

  src = pkgs.lib.cleanSourceWith {
    src = repoRoot;
    filter = path: type:
      craneLib.filterCargoSources path type
      || crateFixturePathFilter path type
      || pkgs.lib.hasSuffix "/web" (toString path)
      || pkgs.lib.hasInfix "/web/" (toString path)
      || pkgs.lib.hasSuffix "/runtime" (toString path)
      || pkgs.lib.hasSuffix "/runtime/git-identity" (toString path);
  };
  runtimeSrc = pkgs.lib.cleanSourceWith {
    src = repoRoot;
    filter = path: type:
      let
        p = toString path;
        isAnvilCtlLibrary = pkgs.lib.hasSuffix "/crates/anvilctl/src/lib.rs" p;
      in (craneLib.filterCargoSources path type || crateFixturePathFilter path type)
        && !isAnvilCtlLibrary
        || pkgs.lib.hasSuffix "/crates/anvilctl/src" p
        || pkgs.lib.hasSuffix "/web" p
        || pkgs.lib.hasInfix "/web/" p
        || pkgs.lib.hasSuffix "/runtime" p
        || pkgs.lib.hasSuffix "/runtime/git-identity" p;
  };
  fixtureSourceSmoke =
    assert crateFixturePathFilter "/repo/crates/anvild/tests/fixtures/controller-v8-sanitized.json" "regular";
    assert crateFixturePathFilter "/repo/crates/anvil-core/tests/fixtures/task-snapshot-v1/fresh-open-executable.json" "regular";
    assert crateFixturePathFilter "/repo/crates/anvil-reconcile/fixtures/action-history-v1.json" "regular";
    assert crateFixturePathFilter "/repo/crates/anvil-reconcile/fixtures" "directory";
    assert !(crateFixturePathFilter "/repo/crates/anvild/target" "directory");
    assert !(crateFixturePathFilter "/repo/crates/anvild/target/debug/fixture.json" "regular");
    assert !(crateFixturePathFilter "/repo/crates/anvil-core/.cache" "directory");
    assert !(crateFixturePathFilter "/repo/.git/fixtures/file.json" "regular");
    pkgs.runCommand "anvil-crate-fixture-source-smoke" { } ''
      test -f "${src}/crates/anvild/tests/fixtures/controller-v8-sanitized.json"
      test -f "${src}/crates/anvild/tests/fixtures/task-migration-mappings-v1.json"
      test -d "${src}/crates/anvil-core/tests/fixtures/task-snapshot-v1"
      if [ -d "${src}/crates/anvil-reconcile" ]; then
        test -d "${src}/crates/anvil-reconcile/fixtures"
      fi
      mkdir -p "$out"
    '';

  baseArgs = {
    inherit src;
    pname = "anvil";
    version = "0.1.0";
    strictDeps = true;
    nativeBuildInputs = [ pkgs.pkg-config pkgs.git ];
  };
  runtimeBaseArgs = baseArgs // { src = runtimeSrc; };
  cargoVendorDir = craneLib.vendorCargoDeps runtimeBaseArgs;
  commonArgs = baseArgs // { inherit cargoVendorDir; };
  runtimeCommonArgs = runtimeBaseArgs // { inherit cargoVendorDir; };

  # Dependency artifacts are profile-specific because Cargo profile metadata
  # is part of the fingerprint used when deciding whether an artifact is fresh.
  mkCargoArtifacts = profile: args: extraArgs:
    craneLib.buildDepsOnly (
      args
      // { CARGO_PROFILE = profile; }
      // extraArgs
    );

  devCargoArtifacts = mkCargoArtifacts "dev" commonArgs {
    # Match the interactive dev profile instead of Crane's non-incremental
    # default, so seeded dependencies remain reusable by ordinary Cargo.
    CARGO_INCREMENTAL = "1";
    # The default buildDepsOnly check uses --all-targets, which pulls test and
    # benchmark features into the fingerprints used by normal cargo build.
    doCheck = false;
  };
  ciCargoArtifacts = mkCargoArtifacts "ci" commonArgs { };
  runtimeBuildArgs = { cargoExtraArgs = "--locked -p anvild -p anvil-mcp -p anvil-router -p anvil-test-model"; };
  ciReleaseCargoArtifacts = mkCargoArtifacts "ci-release" commonArgs { doCheck = false; };
  ciReleaseRuntimeCargoArtifacts = mkCargoArtifacts "ci-release" runtimeCommonArgs (runtimeBuildArgs // { doCheck = false; });
  releaseCargoArtifacts = mkCargoArtifacts "release" runtimeCommonArgs (runtimeBuildArgs // { doCheck = false; });
  anvilCtlReleaseCargoArtifacts = mkCargoArtifacts "release" commonArgs { doCheck = false; cargoExtraArgs = "--locked -p anvilctl"; };
  anvilCtlCiReleaseCargoArtifacts = mkCargoArtifacts "ci-release" commonArgs { doCheck = false; cargoExtraArgs = "--locked -p anvilctl"; };

  mkBinary = {
    package,
    profile,
    cargoArtifacts,
    doCheck ? false,
    src ? commonArgs.src,
  }:
    craneLib.buildPackage ((if src == runtimeSrc then runtimeCommonArgs else commonArgs) // {
      inherit src;
      inherit cargoArtifacts;
      inherit doCheck;
      CARGO_PROFILE = profile;
      cargoExtraArgs = "-p ${package}";
    });

  releaseBinaries = {
    anvild = mkBinary {
      package = "anvild";
      profile = "release";
      cargoArtifacts = releaseCargoArtifacts;
      src = runtimeSrc;
    };
    anvilMcp = mkBinary {
      package = "anvil-mcp";
      profile = "release";
      cargoArtifacts = releaseCargoArtifacts;
      src = runtimeSrc;
    };
    anvilRouter = mkBinary {
      package = "anvil-router";
      profile = "release";
      cargoArtifacts = releaseCargoArtifacts;
      src = runtimeSrc;
    };
    anvilCtl = mkBinary {
      package = "anvilctl";
      profile = "release";
      cargoArtifacts = anvilCtlReleaseCargoArtifacts;
    };
  };

  ciReleaseBinaries = {
    anvild = mkBinary {
      package = "anvild";
      profile = "ci-release";
      cargoArtifacts = ciReleaseRuntimeCargoArtifacts;
      src = runtimeSrc;
    };
    anvilMcp = mkBinary {
      package = "anvil-mcp";
      profile = "ci-release";
      cargoArtifacts = ciReleaseRuntimeCargoArtifacts;
      src = runtimeSrc;
    };
    anvilRouter = mkBinary {
      package = "anvil-router";
      profile = "ci-release";
      cargoArtifacts = ciReleaseRuntimeCargoArtifacts;
      src = runtimeSrc;
    };
    anvilCtl = mkBinary {
      package = "anvilctl";
      profile = "ci-release";
      cargoArtifacts = anvilCtlCiReleaseCargoArtifacts;
    };
    anvilTestModel = mkBinary {
      package = "anvil-test-model";
      profile = "ci-release";
      cargoArtifacts = ciReleaseRuntimeCargoArtifacts;
      src = runtimeSrc;
    };
  };

  devShell = craneLib.devShell {
    packages = [
      craneLib.inheritCargoArtifactsHook
      pkgs.cargo pkgs.rust-analyzer pkgs.cargo-nextest pkgs.just pkgs.git
      pkgs.gh pkgs.curl pkgs.jq pkgs.kubectl pkgs.kustomize pkgs.nix pkgs.nodejs
      pkgs.process-compose pkgs.watchexec nix2containerPkgs.skopeo-nix2container pkgs.util-linux
      opencodePackage
    ] ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [
      pkgs.chromium
    ];
    shellHook = ''
      export CARGO_TARGET_DIR="''${CARGO_TARGET_DIR:-$PWD/target}"
      export FONTCONFIG_FILE="${browserFontsConf}"
      if [ -z "''${CARGO_HOME:-}" ]; then
        export CARGO_HOME="$CARGO_TARGET_DIR/.cargo-home"
        mkdir -p "$CARGO_HOME"
        # Use the same vendored source path that produced the seeded
        # artifacts, otherwise Cargo invalidates every external dependency.
        chmod u+w "$CARGO_HOME/config.toml" 2>/dev/null || true
        cp "${cargoVendorDir}/config.toml" "$CARGO_HOME/config.toml"
        chmod u+w "$CARGO_HOME/config.toml"
      fi
      seed_marker="$CARGO_TARGET_DIR/.anvil-crane-seed"
      seed_artifacts="${devCargoArtifacts}"

      if [ -f "$seed_marker" ] && [ "$(<"$seed_marker")" = "$seed_artifacts" ]; then
        :
      else
        mkdir -p "$CARGO_TARGET_DIR"
        export doNotLinkInheritedArtifacts=1
        if ! inheritCargoArtifacts "$seed_artifacts" "$CARGO_TARGET_DIR"; then
          echo "failed to seed Cargo dependency artifacts" >&2
          unset doNotLinkInheritedArtifacts
          exit 1
        fi
        unset doNotLinkInheritedArtifacts

        marker_tmp="$(mktemp "$seed_marker.XXXXXX")"
        printf '%s\n' "$seed_artifacts" > "$marker_tmp"
        mv -f "$marker_tmp" "$seed_marker"
      fi
    '';
  };
in
{
  inherit
    commonArgs
    cargoVendorDir
    devCargoArtifacts
    ciCargoArtifacts
    ciReleaseCargoArtifacts
    ciReleaseRuntimeCargoArtifacts
    anvilCtlReleaseCargoArtifacts
    anvilCtlCiReleaseCargoArtifacts
    releaseCargoArtifacts
    releaseBinaries
    ciReleaseBinaries
    opencodePackage
    craneLib
    devShell
    fixtureSourceSmoke
    mkBinary
    src;
}
