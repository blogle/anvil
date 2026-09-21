{
  description = "Anvil development environment and reproducible Rust builds";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    crane.url = "github:ipetkov/crane";
    nix2container.url = "github:nlewo/nix2container";
    opencode.url = "github:anomalyco/opencode/v1.18.30";
  };

  outputs = { self, nixpkgs, flake-utils, crane, nix2container, opencode }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        nix2containerPkgs = nix2container.packages.${system};
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
           response="$(${pkgs.curl}/bin/curl --config "$curl_config" --silent --show-error \
             --request POST \
             --header 'content-type: application/json' \
             --data '{"purpose":"gh_read"}' \
             --write-out $'\n%{http_code}' \
             "''${ANVIL_CREDENTIAL_URL%/}/v1/sessions/''${ANVIL_SESSION_ID}/credentials/github")" || {
             echo "gh: broker request failed (no HTTP response)" >&2
             exit 1
           }
           http_status="''${response##*$'\n'}"
           response_body="''${response%$'\n'*}"
           if [[ "$http_status" != 2?? ]]; then
             error_code="$(${pkgs.jq}/bin/jq --raw-output '.error.code // empty' 2>/dev/null <<<"$response_body" || true)"
             error_message="$(${pkgs.jq}/bin/jq --raw-output '.error.message // empty' 2>/dev/null <<<"$response_body" || true)"
             upstream_status="$(${pkgs.jq}/bin/jq --raw-output '.error.upstream_status // empty' 2>/dev/null <<<"$response_body" || true)"
             request_id="$(${pkgs.jq}/bin/jq --raw-output '.error.github_request_id // empty' 2>/dev/null <<<"$response_body" || true)"
             detail="broker request failed (HTTP $http_status)"
             [ -n "$error_code" ] && detail="$detail: $error_code"
             [ -n "$error_message" ] && detail="$detail: $error_message"
             [ -n "$upstream_status" ] && detail="$detail (GitHub HTTP $upstream_status)"
             [ -n "$request_id" ] && detail="$detail [request $request_id]"
             echo "gh: $detail" >&2
             exit 1
           fi
           token="$(${pkgs.jq}/bin/jq --raw-output '.token // empty' <<<"$response_body")"
           if [ -z "$token" ]; then
             echo "gh: broker returned no GitHub token" >&2
             exit 1
           fi
          exec env GH_TOKEN="$token" ${pkgs.gh}/bin/gh "$@"
        '';
        nixConf = pkgs.writeTextDir "etc/nix/nix.conf" ''
          experimental-features = nix-command flakes
          sandbox = false
          build-users-group = nixbld
        '';
        userFiles = [
          (pkgs.writeTextDir "etc/passwd" ''
            root:x:0:0::/root:${pkgs.bash}/bin/bash
            anvil:x:1000:1000::/home/anvil:${pkgs.bash}/bin/bash
            nixbld1:x:30001:30000:Nix build user 1:/var/empty:${pkgs.shadow}/bin/nologin
            nixbld2:x:30002:30000:Nix build user 2:/var/empty:${pkgs.shadow}/bin/nologin
            nixbld3:x:30003:30000:Nix build user 3:/var/empty:${pkgs.shadow}/bin/nologin
            nixbld4:x:30004:30000:Nix build user 4:/var/empty:${pkgs.shadow}/bin/nologin
            nixbld5:x:30005:30000:Nix build user 5:/var/empty:${pkgs.shadow}/bin/nologin
            nixbld6:x:30006:30000:Nix build user 6:/var/empty:${pkgs.shadow}/bin/nologin
            nixbld7:x:30007:30000:Nix build user 7:/var/empty:${pkgs.shadow}/bin/nologin
            nixbld8:x:30008:30000:Nix build user 8:/var/empty:${pkgs.shadow}/bin/nologin
            nobody:x:65534:65534:nobody:/var/empty:${pkgs.coreutils}/bin/false
          '')
          (pkgs.writeTextDir "etc/group" ''
            root:x:0:
            anvil:x:1000:
             nixbld:x:30000:nixbld1,nixbld2,nixbld3,nixbld4,nixbld5,nixbld6,nixbld7,nixbld8
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
        chromiumForImage = pkgs.runCommand "anvil-chromium" {} ''
          mkdir -p "$out"
          cp -a ${pkgs.chromium}/. "$out/"
          chmod u+w "$out/share"
          rm -f "$out/share/man"
        '';
        sandboxEntrypoint = pkgs.writeShellScriptBin "sandbox-entrypoint"
          (builtins.readFile ./runtime/sandbox-entrypoint);
        sandboxMutableHome = pkgs.runCommand "anvil-sandbox-home" {} ''
          mkdir -p "$out/home/anvil"
        '';
        sandboxMutableTmp = pkgs.runCommand "anvil-sandbox-tmp" {} ''
          mkdir -p "$out/tmp"
        '';
        sandboxMutableNixVar = pkgs.runCommand "anvil-sandbox-nix-var" {} ''
          mkdir -p "$out/nix/var/nix/daemon-socket"
        '';
        sandboxUsrBin = pkgs.runCommand "anvil-sandbox-usr-bin" {} ''
          mkdir -p "$out/usr/bin"
          ln -s ${pkgs.coreutils}/bin/env "$out/usr/bin/env"
        '';
        sandboxBaseTools = [
          pkgs.bash pkgs.coreutils pkgs.curl pkgs.cacert pkgs.gitMinimal
          pkgs.openssh pkgs.jq pkgs.procps pkgs.psmisc pkgs.findutils
          pkgs.gnugrep pkgs.gnused pkgs.gawk pkgs.gzip pkgs.which pkgs.less
          pkgs.util-linux
        ];
        sandboxDeveloperTools = [ pkgs.nix pkgs.just pkgs.nodejs ];
        # nix2container layers retain Nix store paths but do not create the
        # conventional command symlinks expected by the Sandbox template.
        sandboxBin = pkgs.buildEnv {
          name = "anvil-sandbox-bin";
          paths = sandboxBaseTools ++ sandboxDeveloperTools ++ [ opencodePackage chromiumForImage pkgs.xorg-server ];
          pathsToLink = [ "/bin" ];
        };
        sandboxRuntimeFiles = [
          nixConf credentialHelper ghWrapper anvilReportPlugin sandboxUsrBin sandboxBin
        ] ++ userFiles ++ [ sandboxMutableHome sandboxMutableTmp sandboxMutableNixVar ];
        sandboxBaseLayer = nix2containerPkgs.nix2container.buildLayer {
          deps = sandboxBaseTools;
          metadata = { created_by = "anvil sandbox: base/runtime Unix tools"; };
        };
        sandboxDeveloperLayer = nix2containerPkgs.nix2container.buildLayer {
          deps = sandboxDeveloperTools;
          layers = [ sandboxBaseLayer ];
          metadata = { created_by = "anvil sandbox: Nix/developer tooling"; };
        };
        sandboxConfig = {
          Cmd = [ "/bin/sandbox-entrypoint" ];
          User = "0:0";
          Env = [
            "HOME=/root"
            "NIX_REMOTE=daemon"
            "NIX_CONFIG=experimental-features = nix-command flakes"
            "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
          ];
        };
        sandboxPerms = [
          {
            path = sandboxMutableHome;
            regex = ".*";
            mode = "0755";
            uid = 1000;
            gid = 1000;
            uname = "anvil";
            gname = "anvil";
          }
          {
            path = sandboxMutableTmp;
            regex = ".*";
            mode = "1777";
          }
          {
            path = sandboxMutableNixVar;
            regex = ".*";
            mode = "0755";
          }
        ];
        mkSandboxImage = {
          tag ? "main",
          config ? sandboxConfig,
          entrypointPackage ? sandboxEntrypoint,
          opencode ? opencodePackage,
          chromium ? chromiumForImage
        }:
          let
            browserLayer = nix2containerPkgs.nix2container.buildLayer {
              deps = [ chromium pkgs.xorg-server ];
              layers = [ sandboxBaseLayer sandboxDeveloperLayer ];
              metadata = { created_by = "anvil sandbox: Chromium/Xvfb"; };
            };
            openCodeLayer = nix2containerPkgs.nix2container.buildLayer {
              deps = [ opencode ];
              layers = [ sandboxBaseLayer sandboxDeveloperLayer browserLayer ];
              metadata = { created_by = "anvil sandbox: OpenCode"; };
            };
          in
          nix2containerPkgs.nix2container.buildImage {
            name = "ghcr.io/blogle/anvil-sandbox";
            inherit tag config;
            copyToRoot = sandboxRuntimeFiles ++ [ entrypointPackage ];
            initializeNixDatabase = true;
            perms = sandboxPerms;
            layers = [
              sandboxBaseLayer
              sandboxDeveloperLayer
              browserLayer
              openCodeLayer
            ];
          };
        anvilImage = pkgs.dockerTools.buildLayeredImage {
          name = "anvil";
          tag = "dev";
          contents = [ anvild anvilMcp anvilRouter pkgs.cacert ];
          config = {
            Cmd = [ "/bin/anvild" ];
            Env = [ "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt" ];
          };
        };
        sandboxImage = mkSandboxImage {};
        sandboxImageEnvCmd = mkSandboxImage {
          tag = "benchmark-env-cmd";
          config = sandboxConfig // {
            Cmd = [ "/bin/sandbox-entrypoint" "--benchmark-env-cmd" ];
            Env = sandboxConfig.Env ++ [ "ANVIL_BENCHMARK=env-cmd" ];
          };
        };
        sandboxImageEntrypoint = mkSandboxImage {
          tag = "benchmark-entrypoint";
          entrypointPackage = pkgs.writeShellScriptBin "sandbox-entrypoint" ''
            exec ${sandboxEntrypoint}/bin/sandbox-entrypoint "$@"
          '';
        };
        sandboxImageOpenCode = mkSandboxImage {
          tag = "benchmark-opencode";
          opencode = pkgs.runCommand "opencode-version-change" {} ''
            cp -a ${opencodePackage}/. "$out/"
            chmod -R u+w "$out"
            mkdir -p "$out/share/anvil"
            printf 'benchmark OpenCode version change\n' > "$out/share/anvil/version-change"
          '';
        };
        sandboxImageChromium = mkSandboxImage {
          tag = "benchmark-chromium";
          chromium = pkgs.runCommand "chromium-version-change" {} ''
            cp -a ${chromiumForImage}/. "$out/"
            chmod -R u+w "$out"
            mkdir -p "$out/share/anvil"
            printf 'benchmark Chromium version change\n' > "$out/share/anvil/version-change"
          '';
        };
         benchmarkSandboxImage = pkgs.writeShellApplication {
           name = "benchmark-sandbox-image";
           runtimeInputs = [ pkgs.coreutils pkgs.nix ];
           text = builtins.readFile ./scripts/benchmark-sandbox-image.sh;
         };
         importSandboxImageK3s = pkgs.writeShellApplication {
             name = "import-sandbox-image-k3s";
             runtimeInputs = [
             pkgs.coreutils pkgs.gawk pkgs.gnugrep pkgs.jq pkgs.kubectl
             nix2containerPkgs.skopeo-nix2container pkgs.gnutar
           ];
           text = builtins.readFile ./scripts/import-sandbox-image-k3s.sh;
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
        packages.anvil-sandbox-image-env-cmd = sandboxImageEnvCmd;
        packages.anvil-sandbox-image-entrypoint = sandboxImageEntrypoint;
        packages.anvil-sandbox-image-opencode = sandboxImageOpenCode;
        packages.anvil-sandbox-image-chromium = sandboxImageChromium;
         packages.anvil-sandbox-image-push = sandboxImage.copyToRegistry;
         packages.benchmark-sandbox-image = benchmarkSandboxImage;
         packages.import-sandbox-image-k3s = importSandboxImageK3s;

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
