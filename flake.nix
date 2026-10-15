{
  description = "Minimal Rust development environment for Anvil v2";

  inputs = {
    sdlc.url = "github:blogle/sdlc/v1.3.0";
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
            doCheck = true;
          };
        in {
          build = package;
          test = package;
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

      ci = forAllSystems (system:
        sdlc.lib.mkConsumer {
          contract = import ./ci.nix { inherit self system; };
        });

      hydraJobs = forAllSystems (system: self.ci.${system}.hydraJobs);

      devShells = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          craneLib = crane.mkLib pkgs;
        in {
          default = craneLib.devShell {
            packages = [ pkgs.just pkgs.nix pkgs.rustfmt ];
          };
        });
    };
}
