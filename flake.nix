{
  description = "Anvil — control plane and operator loop for opencode agent campaigns";

  inputs = {
    # SDLC compatible update channel; flake.lock records the exact revision.
    sdlc.url = "github:blogle/sdlc/v2";

    # Documentation workbench (no release tags yet; pinned by revision).
    fieldnotes.url = "github:blogle/fieldnotes/60f863bc41820fffda1ad8e950438a19b1dbdc2b";

    # Rust build caching, instantiated against SDLC's nixpkgs.
    crane.url = "github:ipetkov/crane";

    # OCI image builds for agent sandboxes (archive-less, layered).
    nix2container.url = "github:nlewo/nix2container";
  };

  outputs = { self, sdlc, fieldnotes, crane, nix2container }:
    let
      systems = [ "x86_64-linux" ];
      nixpkgs = sdlc.nixpkgs-latest;
      version = (builtins.fromTOML (builtins.readFile ./Cargo.toml)).workspace.package.version;
      forSystem = system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          lib = pkgs.lib;
          craneLib = crane.mkLib pkgs;
          src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              (craneLib.fileset.commonCargoSources ./.)
              ./crates/anvild/migrations
              ./crates/anvild/tests/test-github-app.pem
            ];
          };
          commonArgs = {
            inherit src;
            strictDeps = true;
            pname = "anvil-workspace";
            inherit version;
          };
          cargoArtifacts = craneLib.buildDepsOnly commonArgs;
          member = pname:
            craneLib.buildPackage (commonArgs // {
              inherit pname version cargoArtifacts;
              cargoExtraArgs = "-p ${pname}";
              doCheck = false;
            });
        in
        {
          checks = {
            fmt = craneLib.cargoFmt commonArgs;
            clippy = craneLib.cargoClippy (commonArgs // {
              inherit cargoArtifacts;
              cargoClippyExtraArgs = "--all-targets -- --deny warnings";
            });
            test = craneLib.mkCargoDerivation (commonArgs // {
              inherit cargoArtifacts;
              buildPhaseCargoCommand = "cargo test --offline --workspace";
            });
          };

          packages = {
            anvil = member "anvil";
            anvild = member "anvild";
            anvilctl = member "anvilctl";
            anvil-router = member "anvil-router";
            anvil-sandbox-image = import ./images/sandbox-image.nix {
              inherit pkgs;
              nix2container = nix2container.packages.${system}.nix2container;
              anvilctl = member "anvilctl";
            };
          };

          apps = {
            docs = {
              type = "app";
              program = "${fieldnotes.packages.${system}.default}/bin/fieldnotes";
            };
            sdlc = {
              type = "app";
              program = "${sdlc.packages.${system}.sdlc}/bin/sdlc";
            };
          };

          devShells.default = pkgs.mkShell {
            packages = sdlc.lib.devTools {
              inherit pkgs;
              sdlcCli = sdlc.packages.${system}.sdlc;
            } ++ [
              pkgs.cargo
              pkgs.rustc
              pkgs.rustfmt
              pkgs.clippy
              pkgs.rust-analyzer
              pkgs.just
              pkgs.gh
              pkgs.podman
              pkgs.skopeo
            ];
          };
        };
      ci = system:
        sdlc.lib.mkConsumer ((import ./ci.nix { inherit self system; }) // {
          publish = sdlc.ci.${system}.publish;
        });
    in
    {
      checks = nixpkgs.lib.genAttrs systems (system: (forSystem system).checks);
      packages = nixpkgs.lib.genAttrs systems (system: (forSystem system).packages);
      apps = nixpkgs.lib.genAttrs systems (system: (forSystem system).apps);
      devShells = nixpkgs.lib.genAttrs systems (system: (forSystem system).devShells);
      ci = nixpkgs.lib.genAttrs systems ci;
    };
}
