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
  };

  outputs = { self, sdlc, bun2nix, fieldnotes }:
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
        in {
          inherit typescript daemonSmoke;
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
            bunInstallFlags = [ "--linker=hoisted" "--backend=copyfile" ];
            dontUseBunBuild = true;
            dontUseBunCheck = true;
            installPhase = ''
              runHook preInstall
              mkdir -p "$out/bin" "$out/lib/anvil"
              cp -R src "$out/lib/anvil/src"
              cp package.json "$out/lib/anvil/package.json"
              cp -R node_modules "$out/lib/anvil/node_modules"
              cat > "$out/bin/anvil-daemon" <<EOF
              #!${pkgs.runtimeShell}
              exec ${bun}/bin/bun run "$out/lib/anvil/src/main.ts" "\$@"
              EOF
              chmod 0555 "$out/bin/anvil-daemon"
              runHook postInstall
            '';
          };
        in {
          inherit daemon;
          sdlc = sdlc.packages.${system}.sdlc;
          nix-eval-jobs = sdlc.packages.${system}.nix-eval-jobs;
        });

      apps = forAllSystems (system: {
        docs = {
          type = "app";
          program = "${fieldnotes.packages.${system}.default}/bin/fieldnotes";
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
