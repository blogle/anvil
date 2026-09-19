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
        src = pkgs.lib.cleanSourceWith {
          src = ./.;
          filter = path: type:
            craneLib.filterCargoSources path type
            || pkgs.lib.hasSuffix "/web" (toString path)
            || pkgs.lib.hasInfix "/web/" (toString path);
        };
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
        anvilCtl = mkBinary "anvilctl";
        entrypoint = pkgs.writeShellScriptBin "sandbox-entrypoint"
          (builtins.readFile ./runtime/sandbox-entrypoint);
        credentialHelper = pkgs.writeShellScriptBin "anvil-credential"
          (builtins.readFile ./runtime/anvil-credential);
        anvilReportPlugin = pkgs.writeTextDir "usr/share/anvil/anvil-report.ts"
          (builtins.readFile ./runtime/anvil-report.ts);
        ghWrapper = pkgs.writeShellScriptBin "gh" ''
          set -euo pipefail
          : "''${ANVIL_SESSION_ID:?ANVIL_SESSION_ID is required}"
          : "''${ANVIL_CREDENTIAL_URL:?ANVIL_CREDENTIAL_URL is required}"
          : "''${ANVIL_SESSION_CREDENTIAL:?ANVIL_SESSION_CREDENTIAL is required}"
          curl_config="$(mktemp)"
          trap 'rm -f "$curl_config"' EXIT
          (umask 077; printf 'header = "Authorization: Bearer %s"\nheader = "Accept: application/json"\n' \
            "$ANVIL_SESSION_CREDENTIAL" > "$curl_config")
          token="$(${pkgs.curl}/bin/curl --config "$curl_config" --fail-with-body --silent --show-error \
            --request POST \
            "''${ANVIL_CREDENTIAL_URL%/}/v1/sessions/''${ANVIL_SESSION_ID}/credentials/github" \
            | ${pkgs.jq}/bin/jq --raw-output '.token // empty')"
          if [ -z "$token" ]; then
            echo "gh: Anvil could not mint a GitHub credential; check the session and broker" >&2
            exit 1
          fi
          exec env GH_TOKEN="$token" ${pkgs.gh}/bin/gh "$@"
        '';
        nixConf = pkgs.writeTextDir "etc/nix/nix.conf" ''
          experimental-features = nix-command flakes
          sandbox = false
          build-users-group =
        '';
        userFiles = [
          (pkgs.writeTextDir "etc/passwd" ''
            root:x:0:0::/root:${pkgs.bash}/bin/bash
            anvil:x:1000:1000::/home/anvil:${pkgs.bash}/bin/bash
            nobody:x:65534:65534:nobody:/var/empty:${pkgs.coreutils}/bin/false
          '')
          (pkgs.writeTextDir "etc/group" ''
            root:x:0:
            anvil:x:1000:
            nobody:x:65534:
          '')
          (pkgs.writeTextDir "etc/shadow" ''
            root:!x:::::::
            anvil:!:::::::
          '')
          (pkgs.writeTextDir "etc/gshadow" ''
            root:x::
            anvil:x::
          '')
        ];
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
            pkgs.openssh pkgs.jq pkgs.procps pkgs.psmisc pkgs.util-linux
            pkgs.findutils pkgs.gnugrep pkgs.gnused pkgs.gawk pkgs.gzip pkgs.which pkgs.less
            pkgs.chromium pkgs.electron pkgs.xorg-server
            nixConf entrypoint credentialHelper ghWrapper
            anvilReportPlugin
            opencodePackage
          ] ++ userFiles;
          extraCommands = ''
            mkdir -p ./usr/bin ./tmp ./home/anvil ./nix/store ./nix/var
            ln -sfn ${pkgs.coreutils}/bin/env ./usr/bin/env
            chmod 1777 ./tmp
          '';
          fakeRootCommands = ''
            chown -R 1000:1000 ./home/anvil ./nix/var
            chown 1000:1000 ./nix/store
            chmod 600 ./etc/shadow ./etc/gshadow
            chmod 1777 ./tmp
          '';
          config = {
            Cmd = [ "/bin/sandbox-entrypoint" ];
            User = "1000:1000";
            Env = [
              "NIX_REMOTE=local"
              "NIX_CONFIG=experimental-features = nix-command flakes\nsandbox = false\nbuild-users-group ="
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
            pkgs.kubectl pkgs.kustomize pkgs.nix pkgs.nodejs
          ];
        };

        packages.default = anvilImage;
        packages.anvild = anvild;
        packages.anvil-mcp = anvilMcp;
        packages.anvil-router = anvilRouter;
        packages.anvilctl = anvilCtl;
        packages.anvil-image = anvilImage;
        packages.anvil-sandbox-image = sandboxImage;

        checks = {
          fmt = craneLib.cargoFmt (commonArgs // { cargoFmtExtraArgs = "--all"; });
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
