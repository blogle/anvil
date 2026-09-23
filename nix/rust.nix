{ pkgs, craneLib, repoRoot }:

let
  # Keep the Cargo source filter here so the root flake only wires modules
  # together.  The web application is part of the Rust build input.
  src = pkgs.lib.cleanSourceWith {
    src = repoRoot;
    filter = path: type:
      craneLib.filterCargoSources path type
      || pkgs.lib.hasSuffix "/web" (toString path)
      || pkgs.lib.hasInfix "/web/" (toString path);
  };

  baseArgs = {
    inherit src;
    pname = "anvil";
    version = "0.1.0";
    strictDeps = true;
    nativeBuildInputs = [ pkgs.pkg-config ];
  };
  vendorCargoDir = craneLib.vendorCargoDeps baseArgs;
  commonArgs = baseArgs // { inherit vendorCargoDir; };

  # Dependency artifacts are profile-specific because Cargo profile metadata
  # is part of the fingerprint used when deciding whether an artifact is fresh.
  mkCargoArtifacts = profile: extraArgs:
    craneLib.buildDepsOnly (
      commonArgs
      // { CARGO_PROFILE = profile; }
      // extraArgs
    );

  devCargoArtifacts = mkCargoArtifacts "dev" {
    # Match the interactive dev profile instead of Crane's non-incremental
    # default, so seeded dependencies remain reusable by ordinary Cargo.
    CARGO_INCREMENTAL = "1";
    # The default buildDepsOnly check uses --all-targets, which pulls test and
    # benchmark features into the fingerprints used by normal cargo build.
    doCheck = false;
  };
  ciCargoArtifacts = mkCargoArtifacts "ci" { };
  ciReleaseCargoArtifacts = mkCargoArtifacts "ci-release" { };
  releaseCargoArtifacts = mkCargoArtifacts "release" { };

  mkBinary = {
    package,
    profile,
    cargoArtifacts,
  }:
    craneLib.buildPackage (commonArgs // {
      inherit cargoArtifacts;
      CARGO_PROFILE = profile;
      cargoExtraArgs = "-p ${package}";
    });

  releaseBinaries = {
    anvild = mkBinary {
      package = "anvild";
      profile = "release";
      cargoArtifacts = releaseCargoArtifacts;
    };
    anvilMcp = mkBinary {
      package = "anvil-mcp";
      profile = "release";
      cargoArtifacts = releaseCargoArtifacts;
    };
    anvilRouter = mkBinary {
      package = "anvil-router";
      profile = "release";
      cargoArtifacts = releaseCargoArtifacts;
    };
    anvilCtl = mkBinary {
      package = "anvilctl";
      profile = "release";
      cargoArtifacts = releaseCargoArtifacts;
    };
  };

  ciReleaseBinaries = {
    anvild = mkBinary {
      package = "anvild";
      profile = "ci-release";
      cargoArtifacts = ciReleaseCargoArtifacts;
    };
    anvilMcp = mkBinary {
      package = "anvil-mcp";
      profile = "ci-release";
      cargoArtifacts = ciReleaseCargoArtifacts;
    };
    anvilRouter = mkBinary {
      package = "anvil-router";
      profile = "ci-release";
      cargoArtifacts = ciReleaseCargoArtifacts;
    };
    anvilCtl = mkBinary {
      package = "anvilctl";
      profile = "ci-release";
      cargoArtifacts = ciReleaseCargoArtifacts;
    };
  };

  checks = {
    fmt = craneLib.cargoFmt (commonArgs // { cargoFmtExtraArgs = "--all"; });
    clippy = craneLib.cargoClippy (commonArgs // {
      cargoArtifacts = ciCargoArtifacts;
      CARGO_PROFILE = "ci";
      cargoClippyExtraArgs = "--workspace --all-targets --all-features -- -D warnings";
    });
    tests = craneLib.cargoTest (commonArgs // {
      cargoArtifacts = ciCargoArtifacts;
      CARGO_PROFILE = "ci";
      cargoExtraArgs = "--workspace";
    });
  };

  devShell = craneLib.devShell {
    packages = [
      craneLib.inheritCargoArtifactsHook
      pkgs.cargo pkgs.rust-analyzer pkgs.cargo-nextest pkgs.just pkgs.git
      pkgs.gh pkgs.curl pkgs.jq pkgs.kubectl pkgs.kustomize pkgs.nix pkgs.nodejs
    ];
    shellHook = ''
      set -euo pipefail
      export CARGO_TARGET_DIR="''${CARGO_TARGET_DIR:-$PWD/target}"
      if [ -z "''${CARGO_HOME:-}" ]; then
        export CARGO_HOME="$CARGO_TARGET_DIR/.cargo-home"
        mkdir -p "$CARGO_HOME"
        # Use the same vendored source path that produced the seeded
        # artifacts, otherwise Cargo invalidates every external dependency.
        chmod u+w "$CARGO_HOME/config.toml" 2>/dev/null || true
        cp "${vendorCargoDir}/config.toml" "$CARGO_HOME/config.toml"
        chmod u+w "$CARGO_HOME/config.toml"
      fi
      seed_marker="$CARGO_TARGET_DIR/.anvil-crane-seed"
      seed_artifacts="${devCargoArtifacts}"

      if [ -f "$seed_marker" ] && [ "$(<"$seed_marker")" = "$seed_artifacts" ]; then
        :
      else
        mkdir -p "$CARGO_TARGET_DIR"
        export doNotLinkInheritedArtifacts=1
        inheritCargoArtifacts "${devCargoArtifacts}" "$CARGO_TARGET_DIR"

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
    devCargoArtifacts
    ciCargoArtifacts
    ciReleaseCargoArtifacts
    releaseCargoArtifacts
    releaseBinaries
    ciReleaseBinaries
    checks
    devShell
    mkBinary
    src;
}
