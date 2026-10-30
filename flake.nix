{
  description = "Bun-first local development for the Anvil pre-1.0 rewrite";

  inputs = {
    sdlc.url = "github:blogle/sdlc/v2";
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "sdlc/nixpkgs-latest";
    };
    fieldnotes = {
      url = "github:blogle/fieldnotes";
      inputs.sdlc.follows = "sdlc";
    };
    nix2container = {
      url = "github:nlewo/nix2container";
      inputs.nixpkgs.follows = "sdlc/nixpkgs-latest";
    };
  };

  outputs = { self, sdlc, bun2nix, fieldnotes, nix2container }:
    let
      systems = [ "x86_64-linux" ];
      forAllSystems = f: builtins.listToAttrs (map (system: {
        name = system;
        value = f system;
      }) systems);
    in {
      checks = forAllSystems (system:
        let
          pkgs = (sdlc.lib.importPackages { inherit system; }).latest;
          bun = import ./nix/bun.nix { inherit pkgs; };
          bun2nixPackage = bun2nix.packages.${system}.default;
          typescript = pkgs.stdenvNoCC.mkDerivation {
            pname = "anvil-typescript-check";
            version = "0.1.0";
            src = ./.;
            nativeBuildInputs = [
              bun
              bun2nixPackage
              bun2nixPackage.hook
              pkgs.gitMinimal
            ];
            bunDeps = bun2nixPackage.fetchBunDeps { bunNix = ./bun.nix; };
            bunInstallFlags = [ "--linker=hoisted" "--backend=copyfile" ];
            dontUseBunBuild = true;
            dontUseBunCheck = true;
            dontUseBunInstall = true;
            buildPhase = ''
              runHook preBuild
              bun2nix -o "$TMPDIR/bun.nix"
              cmp "$TMPDIR/bun.nix" ${./bun.nix}
              bun run check
              runHook postBuild
            '';
            installPhase = ''
              mkdir -p "$out"
              touch "$out/check-passed"
            '';
          };
          daemonSmoke = pkgs.runCommand "anvil-daemon-smoke" {
            nativeBuildInputs = [ bun ];
          } ''
            ${bun}/bin/bun ${./scripts/smoke-daemon-package.ts} ${self.packages.${system}.daemon}/bin/anvil-daemon
            touch "$out"
          '';
          opencodeSmoke = pkgs.runCommand "anvil-opencode-runtime-smoke" {
            nativeBuildInputs = [ bun ];
          } ''
            ${bun}/bin/bun ${./.}/scripts/smoke-opencode-runtime.ts ${self.packages.${system}.opencodeRuntime}/bin/opencode ${pkgs.opencode.version}
            touch "$out"
          '';
          sandboxImageGate = pkgs.runCommand "anvil-sandbox-image-gate" {
            nativeBuildInputs = [ bun ];
          } ''
            ${bun}/bin/bun ${./.}/scripts/check-sandbox-worker-image.ts \
              ${self.packages.${system}.sandboxWorkerImage} \
              ${pkgs.closureInfo { rootPaths = [ self.packages.${system}.sandboxWorkerImage ]; }}/store-paths \
              ${pkgs.opencode} \
              ${pkgs.gitMinimal}
            touch "$out"
          '';
        in {
          inherit typescript daemonSmoke opencodeSmoke sandboxImageGate;
          flake = pkgs.runCommand "anvil-flake-check" { } ''
            test -f ${./flake.nix}
            test -f ${./flake.lock}
            test -f ${./bun.lock}
            touch $out
          '';
        });

      packages = forAllSystems (system:
        let
          pkgs = (sdlc.lib.importPackages { inherit system; }).latest;
          bun = import ./nix/bun.nix { inherit pkgs; };
          bun2nixPackage = bun2nix.packages.${system}.default;
          nix2containerPackage = nix2container.packages.${system}.nix2container;
          ui = pkgs.stdenvNoCC.mkDerivation {
            pname = "anvil-ui";
            version = "0.1.0";
            src = ./.;
            nativeBuildInputs = [ bun bun2nixPackage bun2nixPackage.hook ];
            bunDeps = bun2nixPackage.fetchBunDeps { bunNix = ./bun.nix; };
            bunInstallFlags = [ "--linker=hoisted" "--backend=copyfile" ];
            dontUseBunBuild = true;
            dontUseBunCheck = true;
            buildPhase = ''
              runHook preBuild
              bun run ui:build
              runHook postBuild
            '';
            installPhase = ''
              mkdir -p "$out"
              cp -R dist/ui/. "$out/"
            '';
          };
          daemon = pkgs.stdenvNoCC.mkDerivation {
            pname = "anvil-daemon";
            version = "0.1.0";
            src = ./.;
            nativeBuildInputs = [
              bun
              bun2nixPackage
              bun2nixPackage.hook
            ];
            bunDeps = bun2nixPackage.fetchBunDeps { bunNix = ./bun.nix; };
            bunInstallFlags = [ "--production" "--linker=hoisted" "--backend=copyfile" ];
            dontUseBunBuild = true;
            dontUseBunCheck = true;
            installPhase = ''
              runHook preInstall
              mkdir -p "$out/bin" "$out/lib/anvil"
              cp -R src "$out/lib/anvil/src"
              cp package.json "$out/lib/anvil/package.json"
              cp -R node_modules "$out/lib/anvil/node_modules"
              cp -R ${ui} "$out/lib/anvil/ui"
              cat > "$out/bin/anvil-daemon" <<EOF
              #!${pkgs.runtimeShell}
              export ANVIL_UI_DIRECTORY="$out/lib/anvil/ui"
              exec ${bun}/bin/bun run "$out/lib/anvil/src/main.ts" "\$@"
              EOF
              chmod 0555 "$out/bin/anvil-daemon"
              runHook postInstall
            '';
          };
          opencodeRuntime = pkgs.opencode;
          workerTools = pkgs.buildEnv {
            name = "anvil-sandbox-worker-tools";
            paths = [
              pkgs.bashInteractive
              pkgs.coreutils
              pkgs.diffutils
              pkgs.findutils
              pkgs.gawk
              pkgs.gitMinimal
              pkgs.gnugrep
              pkgs.gnused
              pkgs.jq
              pkgs.nix
              pkgs.ripgrep
            ];
            pathsToLink = [ "/bin" ];
          };
          workerWritablePaths = pkgs.runCommand "anvil-sandbox-worker-writable-paths" { } ''
            mkdir -p "$out/home/anvil/workspace" "$out/tmp"
            chmod 0777 "$out/home/anvil" "$out/home/anvil/workspace"
            chmod 1777 "$out/tmp"
          '';
          workerIdentity = pkgs.runCommand "anvil-sandbox-worker-identity" { } ''
            mkdir -p "$out/etc"
            printf '%s\n' 'anvil:x:1000:1000:Anvil worker:/home/anvil:/bin/bash' > "$out/etc/passwd"
            printf '%s\n' 'anvil:x:1000:' > "$out/etc/group"
            chmod 0444 "$out/etc/passwd" "$out/etc/group"
          '';
          workerRuntimeClosure = pkgs.closureInfo {
            rootPaths = [
              workerTools
              workerWritablePaths
              workerIdentity
              workerEntrypoint
              pkgs.opencode
              pkgs.cacert
            ];
          };
          workerClosureManifest = pkgs.runCommand "anvil-sandbox-worker-closure-manifest" { } ''
            cp ${workerRuntimeClosure}/store-paths "$out"
            chmod 0444 "$out"
          '';
          workerStorePreflight = pkgs.runCommand "anvil-sandbox-worker-store-preflight" { } ''
            manifest_sha256="$(${pkgs.coreutils}/bin/sha256sum ${workerClosureManifest} | ${pkgs.coreutils}/bin/cut -d ' ' -f 1)"
            mkdir -p "$out/bin"
            printf '#!%s\nexpected_manifest_sha256="%s"\n' \
              "${pkgs.bash}/bin/bash" "$manifest_sha256" > "$out/bin/anvil-verify-worker-store-closure"
            cat >> "$out/bin/anvil-verify-worker-store-closure" <<'EOF'
            set -euo pipefail

            store_uri="''${1:-daemon}"
            manifest="''${2:-/etc/anvil/worker-image-closure.paths}"
            shared_store_root="''${3:-/run/anvil/shared-nix/store}"
            nix_executable="''${4:-/bin/nix}"
            if [ ! -d "$shared_store_root" ] || [ ! -r "$shared_store_root" ]; then
              printf '%s\n' "shared Nix store mount is unavailable" >&2
              exit 78
            fi
            if [ ! -r "$manifest" ]; then
              printf '%s\n' "worker closure manifest is unavailable" >&2
              exit 78
            fi
            actual_manifest_sha256="$("${pkgs.coreutils}/bin/sha256sum" "$manifest" | "${pkgs.coreutils}/bin/cut" -d ' ' -f 1)"
            if [ "$actual_manifest_sha256" != "$expected_manifest_sha256" ]; then
              printf '%s\n' "BLOCKED: worker closure manifest does not match the image-pinned digest" >&2
              exit 78
            fi
            mapfile -t required_paths < "$manifest"
            if [ "''${#required_paths[@]}" -eq 0 ]; then
              printf '%s\n' "worker closure manifest is empty" >&2
              exit 78
            fi
            for store_path in "''${required_paths[@]}"; do
              case "$store_path" in
                /nix/store/*) ;;
                *)
                  printf '%s\n' "worker closure manifest contains a non-store path" >&2
                  exit 78
                  ;;
              esac
            done

            preflight_home="$("${pkgs.coreutils}/bin/mktemp" -d "''${TMPDIR:-/tmp}/anvil-store-preflight.XXXXXX")"
            trap '"${pkgs.coreutils}/bin/rm" -rf "$preflight_home"' EXIT
            export HOME="$preflight_home"
            export XDG_CACHE_HOME="$HOME/.cache"
            export XDG_CONFIG_HOME="$HOME/.config"
            export XDG_DATA_HOME="$HOME/.local/share"
            export XDG_STATE_HOME="$HOME/.local/state"
            "${pkgs.coreutils}/bin/mkdir" -p "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

            daemon_path_info="$("$nix_executable" --offline path-info --store "$store_uri" \
              --json --json-format 1 "''${required_paths[@]}")" || {
              printf '%s\n' "BLOCKED: required worker closure paths are missing or unregistered" >&2
              exit 78
            }
            if ! "$nix_executable" --offline store verify --store "$store_uri" \
              --no-trust "''${required_paths[@]}" >/dev/null 2>&1; then
              printf '%s\n' "BLOCKED: shared Nix store failed content verification for the worker closure" >&2
              exit 78
            fi
            for store_path in "''${required_paths[@]}"; do
              mounted_path="$shared_store_root/''${store_path##*/}"
              if [ ! -e "$mounted_path" ] && [ ! -L "$mounted_path" ]; then
                printf 'BLOCKED: mounted shared store is missing %s\n' "''${store_path##*/}" >&2
                exit 78
              fi
              mounted_paths+=("$mounted_path")
            done
            daemon_nar_hashes="$(printf '%s' "$daemon_path_info" | ${pkgs.jq}/bin/jq -er --rawfile manifest "$manifest" '. as $info | ($manifest | split("\n") | map(select(length > 0)))[] as $path | $info[$path].narHash // empty')" || {
              printf '%s\n' "BLOCKED: Nix daemon did not provide the complete registered NAR hash list" >&2
              exit 78
            }
            mapfile -t daemon_nar_hashes <<< "$daemon_nar_hashes"
            mounted_nar_hashes="$("$nix_executable" --offline hash path --type sha256 "''${mounted_paths[@]}")" || {
              printf '%s\n' "BLOCKED: mounted shared-store closure could not be NAR-hashed" >&2
              exit 78
            }
            mapfile -t mounted_nar_hashes <<< "$mounted_nar_hashes"
            if [ "''${#daemon_nar_hashes[@]}" -ne "''${#required_paths[@]}" ] || \
              [ "''${#mounted_nar_hashes[@]}" -ne "''${#required_paths[@]}" ]; then
              printf '%s\n' "BLOCKED: NAR hash count does not match the pinned runtime closure" >&2
              exit 78
            fi
            for index in "''${!required_paths[@]}"; do
              if [ "''${mounted_nar_hashes[$index]}" != "''${daemon_nar_hashes[$index]}" ]; then
                printf 'BLOCKED: mounted bytes do not match daemon NAR hash for %s\n' "''${required_paths[$index]##*/}" >&2
                exit 78
              fi
            done
            printf 'worker shared-store preflight passed (%s paths)\n' "''${#required_paths[@]}"
            EOF
            chmod 0555 "$out/bin/anvil-verify-worker-store-closure"
          '';
          workerPreflightRoot = pkgs.buildEnv {
            name = "anvil-sandbox-worker-preflight-command";
            paths = [ workerStorePreflight ];
            pathsToLink = [ "/bin" ];
          };
          workerClosureManifestRoot = pkgs.runCommand "anvil-sandbox-worker-closure-manifest-root" { } ''
            mkdir -p "$out/etc/anvil"
            cp ${workerClosureManifest} "$out/etc/anvil/worker-image-closure.paths"
            chmod 0444 "$out/etc/anvil/worker-image-closure.paths"
          '';
          workerEntrypoint = pkgs.writeShellScriptBin "anvil-opencode-server" ''
            set -euo pipefail

            port="''${OPENCODE_PORT:-4096}"
            case "$port" in
              ""|*[!0-9]*)
                printf '%s\n' "OPENCODE_PORT must be a nonprivileged TCP port" >&2
                exit 64
                ;;
            esac
            if [ "''${#port}" -gt 5 ]; then
              printf '%s\n' "OPENCODE_PORT must be between 1024 and 65535" >&2
              exit 64
            fi
            port_number=$((10#$port))
            if [ "$port_number" -lt 1024 ] || [ "$port_number" -gt 65535 ]; then
              printf '%s\n' "OPENCODE_PORT must be between 1024 and 65535" >&2
              exit 64
            fi

            export HOME="''${HOME:-/home/anvil}"
            export ANVIL_WORKSPACE="''${ANVIL_WORKSPACE:-/home/anvil/workspace}"
            export XDG_CONFIG_HOME="''${XDG_CONFIG_HOME:-$HOME/.config}"
            export XDG_CACHE_HOME="''${XDG_CACHE_HOME:-$HOME/.cache}"
            export XDG_DATA_HOME="''${XDG_DATA_HOME:-$HOME/.local/share}"
            export XDG_STATE_HOME="''${XDG_STATE_HOME:-$HOME/.local/state}"
            export TMPDIR="''${TMPDIR:-/tmp}"
            export PATH="/bin"
            export SSL_CERT_FILE="${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"

            mkdir -p "$HOME" "$ANVIL_WORKSPACE" "$XDG_CONFIG_HOME" \
              "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$TMPDIR"
            for writable_path in "$HOME" "$ANVIL_WORKSPACE" "$XDG_CONFIG_HOME" \
              "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$TMPDIR"; do
              if [ ! -w "$writable_path" ]; then
                printf '%s\n' "OpenCode worker path is not writable: $writable_path" >&2
                exit 73
              fi
            done
            cd "$ANVIL_WORKSPACE"
            exec ${pkgs.opencode}/bin/opencode serve \
              --hostname "''${OPENCODE_HOST:-0.0.0.0}" \
              --port "$port_number"
          '';
          workerToolsLayer = nix2containerPackage.buildLayer {
            deps = [ workerTools ];
            metadata = {
              created_by = "Anvil sandbox worker runtime";
              comment = "Git and shell tooling";
            };
          };
          workerOpenCodeLayer = nix2containerPackage.buildLayer {
            deps = [ pkgs.opencode pkgs.cacert ];
            metadata = {
              created_by = "Anvil sandbox worker runtime";
              comment = "Pinned OpenCode v2.0.32 runtime";
            };
          };
          workerEntrypointLayer = nix2containerPackage.buildLayer {
            deps = [ workerEntrypoint ];
            metadata = {
              created_by = "Anvil sandbox worker runtime";
              comment = "Non-root OpenCode server entrypoint";
            };
          };
          workerPreflightLayer = nix2containerPackage.buildLayer {
            deps = [ workerPreflightRoot workerStorePreflight ];
            metadata = {
              created_by = "Anvil sandbox worker runtime";
              comment = "Fail-closed shared-store closure preflight";
            };
          };
          sandboxWorkerImage = nix2containerPackage.buildImage {
            name = "anvil-sandbox-worker";
            tag = "opencode-${pkgs.opencode.version}";
            copyToRoot = [
              workerTools
              workerPreflightRoot
              workerWritablePaths
              workerIdentity
              workerClosureManifestRoot
            ];
            layers = [
              workerToolsLayer
              workerOpenCodeLayer
              workerEntrypointLayer
              workerPreflightLayer
            ];
            perms = [
              {
                path = workerWritablePaths;
                regex = "^/home/anvil(/workspace)?$";
                mode = "0777";
              }
              {
                path = workerWritablePaths;
                regex = "^/tmp$";
                mode = "1777";
              }
            ];
            config = {
              Entrypoint = [ "${workerEntrypoint}/bin/anvil-opencode-server" ];
              Env = [
                "HOME=/home/anvil"
                "ANVIL_WORKSPACE=/home/anvil/workspace"
                "XDG_CONFIG_HOME=/home/anvil/.config"
                "XDG_CACHE_HOME=/home/anvil/.cache"
                "XDG_DATA_HOME=/home/anvil/.local/share"
                "XDG_STATE_HOME=/home/anvil/.local/state"
                "TMPDIR=/tmp"
                "PATH=/bin"
                "OPENCODE_PORT=4096"
                "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
              ];
              ExposedPorts = { "4096/tcp" = { }; };
              User = "1000:1000";
              WorkingDir = "/home/anvil/workspace";
            };
          };
          sandboxWorkerStorePreflight = workerStorePreflight;
          sandboxWorkerClosureManifest = workerClosureManifest;
        in {
          inherit
            daemon
            ui
            opencodeRuntime
            sandboxWorkerImage
            sandboxWorkerStorePreflight
            sandboxWorkerClosureManifest
            ;
          sdlc = sdlc.packages.${system}.sdlc;
          nix-eval-jobs = sdlc.packages.${system}.nix-eval-jobs;
        });

      apps = forAllSystems (system:
        let
          pkgs = (sdlc.lib.importPackages { inherit system; }).latest;
          bun = import ./nix/bun.nix { inherit pkgs; };
          image = self.packages.${system}.sandboxWorkerImage;
          imageClosure = pkgs.closureInfo { rootPaths = [ image ]; };
          runtimeManifest = self.packages.${system}.sandboxWorkerClosureManifest;
          preflight = self.packages.${system}.sandboxWorkerStorePreflight;
          seedProof = pkgs.writeShellScriptBin "anvil-sandbox-worker-store-seed-proof" ''
            exec ${bun}/bin/bun ${./.}/scripts/prove-sandbox-worker-store-seed.ts \
              ${pkgs.nix}/bin/nix ${image} ${imageClosure}/store-paths \
              ${runtimeManifest} ${preflight}/bin/anvil-verify-worker-store-closure
          '';
          signatureProof = pkgs.writeShellScriptBin "anvil-sandbox-worker-store-signature-proof" ''
            exec ${bun}/bin/bun ${./.}/scripts/prove-sandbox-worker-store-signatures.ts \
              ${pkgs.nix}/bin/nix ${self.packages.${system}.sandboxWorkerClosureManifest} \
              ${runtimeManifest} ${preflight}/bin/anvil-verify-worker-store-closure
          '';
        in {
          docs = {
            type = "app";
            program = "${fieldnotes.packages.${system}.default}/bin/fieldnotes";
          };
          sandboxWorkerStoreSeed = {
            type = "app";
            program = "${seedProof}/bin/anvil-sandbox-worker-store-seed-proof";
          };
          sandboxWorkerStoreSignatures = {
            type = "app";
            program = "${signatureProof}/bin/anvil-sandbox-worker-store-signature-proof";
          };
        });

      publish = forAllSystems (system:
        let pkgs = (sdlc.lib.importPackages { inherit system; }).latest;
        in {
          type = "app";
          program = "${pkgs.writeShellScript "anvil-sdlc-publish" ''
            echo "Anvil has no application package or deployment artifact in this checkpoint."
            exit 1
          ''}";
        });

      ci = forAllSystems (system:
        sdlc.lib.mkConsumer {
          inherit (import ./ci.nix { inherit self system; }) check verify;
          publish = self.publish.${system};
        });

      devShells = forAllSystems (system:
        let
          pkgs = (sdlc.lib.importPackages { inherit system; }).latest;
          bun = import ./nix/bun.nix { inherit pkgs; };
        in {
          default = pkgs.mkShell {
            packages = [
              bun
              bun2nix.packages.${system}.default
              pkgs.gitMinimal
              pkgs.just
              pkgs.nix
            ];
          };
        });
    };
}
