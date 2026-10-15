{
  description = "Minimal Rust development environment for Anvil v2";

  inputs = {
    # TODO: replace this pre-release evaluation pin with a tagged SDLC release
    # whose API matches main before promoting this branch to anvil-v2/main.
    sdlc.url = "github:blogle/sdlc/de40fc00bc632b7acd0b0ba5de1242f1af827a9f";
    nixpkgs.follows = "sdlc/nixpkgs";
    crane.url = "github:ipetkov/crane";
  };

  outputs = { self, nixpkgs, sdlc, crane }:
    let
      systems = [ "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      checks = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          craneLib = crane.mkLib pkgs;
          src = craneLib.cleanCargoSource ./.;
          cargoArtifacts = craneLib.buildDepsOnly { inherit src; };
          package = craneLib.buildPackage {
            inherit src cargoArtifacts;
            doCheck = false;
          };
          tests = craneLib.buildPackage {
            inherit src cargoArtifacts;
            doCheck = true;
          };
        in {
          build = package;
          inherit tests;
          fmt = craneLib.cargoFmt { inherit src; };
          clippy = craneLib.cargoClippy {
            inherit src cargoArtifacts;
            cargoClippyExtraArgs = "--all-targets -- -D warnings";
          };
        });

      packages = forAllSystems (system: {
        default = self.checks.${system}.build;
        sdlc = sdlc.packages.${system}.sdlc;
      });

      ci = forAllSystems (system:
        sdlc.lib.mkConsumer (import ./ci.nix {
          inherit self system;
          pkgs = nixpkgs.legacyPackages.${system};
        }));

      devShells = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          craneLib = crane.mkLib pkgs;
        in {
          default = craneLib.devShell {
            packages = sdlc.lib.devTools {
              inherit pkgs;
              sdlcCli = sdlc.packages.${system}.sdlc;
            } ++ [ pkgs.just pkgs.gh ];
          };
        });
    };
}
