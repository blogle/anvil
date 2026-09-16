{
  description = "Anvil development environment and reproducible Rust builds";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    crane.url = "github:ipetkov/crane";
    opencode.url = "github:anomalyco/opencode/v1.18.30";
  };

  outputs = { self, nixpkgs, flake-utils, crane, opencode }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        # nixpkgs is used here rather than rustup so evaluation remains
        # self-contained.  It is kept compatible with rust-toolchain.toml's
        # 1.82 pin through the workspace rust-version.
        toolchain = pkgs.rustc;
        # Do not override with rustc alone: Crane needs a complete toolchain
        # (cargo plus rustc) for dependency derivations.
        craneLib = crane.mkLib pkgs;
        src = craneLib.cleanCargoSource ./.;
        commonArgs = {
          inherit src;
          pname = "anvil";
          version = "0.1.0";
          strictDeps = true;
          nativeBuildInputs = [ pkgs.pkg-config ];
        };
        cargoArtifacts = craneLib.buildDepsOnly commonArgs;
        mkBinary = package: craneLib.buildPackage (commonArgs // {
          inherit cargoArtifacts;
          cargoExtraArgs = "-p ${package}";
        });
        anvild = mkBinary "anvild";
        anvilMcp = mkBinary "anvil-mcp";
        anvilRouter = mkBinary "anvil-router";
        entrypoint = pkgs.writeShellScriptBin "sandbox-entrypoint"
          (builtins.readFile ./runtime/sandbox-entrypoint);
        nixConf = pkgs.writeTextDir "etc/nix/nix.conf" ''
          experimental-features = nix-command flakes
          sandbox = false
        '';
        opencodePackage = opencode.packages.${system}.default;
        anvilImage = pkgs.dockerTools.buildLayeredImage {
          name = "anvil";
          tag = "dev";
          contents = [ anvild anvilMcp anvilRouter pkgs.cacert ];
          config = {
            Cmd = [ "/bin/anvild" ];
            Env = [ "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt" ];
          };
        };
        sandboxImage = pkgs.dockerTools.buildLayeredImage {
          name = "anvil-sandbox";
          tag = "dev";
          contents = [
            pkgs.bash pkgs.coreutils pkgs.curl pkgs.cacert pkgs.git pkgs.nix
            nixConf entrypoint
          opencodePackage
          ];
          config = {
            Cmd = [ "/bin/sandbox-entrypoint" ];
            Env = [
              "NIX_CONFIG=experimental-features = nix-command flakes\nsandbox = false"
              "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
            ];
          };
        };
      in {
        devShells.default = pkgs.mkShell {
          # The shell provides tools only; it intentionally does not depend on
          # any package above and therefore does not build the project.
          packages = [
            toolchain pkgs.cargo pkgs.rustfmt pkgs.clippy pkgs.rust-analyzer
            pkgs.cargo-nextest pkgs.just pkgs.git pkgs.gh pkgs.curl pkgs.jq
            pkgs.kubectl pkgs.kustomize pkgs.nix
          ];
        };

        packages.default = anvilImage;
        packages.anvild = anvild;
        packages.anvil-mcp = anvilMcp;
        packages.anvil-router = anvilRouter;
        packages.anvil-image = anvilImage;
        packages.anvil-sandbox-image = sandboxImage;

        checks = {
          fmt = craneLib.cargoFmt (commonArgs // { cargoExtraArgs = "--all"; });
          clippy = craneLib.cargoClippy (commonArgs // {
            inherit cargoArtifacts;
            cargoClippyExtraArgs = "--workspace --all-targets --all-features -- -D warnings";
          });
          tests = craneLib.cargoTest (commonArgs // {
            inherit cargoArtifacts;
            cargoExtraArgs = "--workspace";
          });
        };
      });
}
