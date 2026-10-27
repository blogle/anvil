{
  description = "Bun-first development environment for the Anvil pre-1.0 rewrite";

  inputs = {
    sdlc.url = "github:blogle/sdlc/v2";
    crane.url = "github:ipetkov/crane";
    fieldnotes = {
      url = "github:blogle/fieldnotes";
      inputs.sdlc.follows = "sdlc";
    };
  };

  outputs = { self, sdlc, crane, fieldnotes }:
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
          craneLib = crane.mkLib pkgs;
          src = craneLib.cleanCargoSource ./.;
          cargoArtifacts = craneLib.buildDepsOnly { inherit src; };
          typescript = pkgs.buildNpmPackage {
            pname = "anvil-typescript-check";
            version = "0.1.0";
            src = ./.;
            npmDepsHash = "sha256-zqpvZil2sFD649Wh1G6CdJTKFADSDCJ4IjnG/J9rTtk=";
            npmDepsFetcherVersion = 2;
            dontNpmBuild = true;
            nativeBuildInputs = [ pkgs.bun ];
            installPhase = ''
              runHook preInstall
              bun run fmt:check
              bun run typecheck
              bun test
              mkdir -p $out
              touch $out
              runHook postInstall
            '';
          };
          package = craneLib.buildPackage {
            inherit src cargoArtifacts;
            doCheck = true;
          };
        in {
          build = package;
          test = package;
          inherit typescript;
          fmt = craneLib.cargoFmt { inherit src; };
          clippy = craneLib.cargoClippy {
            inherit src cargoArtifacts;
            cargoClippyExtraArgs = "--all-targets -- -D warnings";
          };
          flake = pkgs.runCommand "anvil-v2-flake-check" { } ''
            test -f ${./flake.nix}
            test -f ${./flake.lock}
            touch $out
          '';
        });

      packages = forAllSystems (system: {
        default = self.checks.${system}.build;
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
            echo "Anvil's pre-1.0 rewrite scaffold has no deployment artifacts."
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
          craneLib = crane.mkLib pkgs;
        in {
          default = craneLib.devShell {
            packages = [
              pkgs.bun
              pkgs.just
              pkgs.nix
              pkgs.nodejs
              pkgs.rustfmt
            ];
          };
        });
    };
}
