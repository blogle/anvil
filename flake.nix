{
  description = "Anvil — control plane and operator loop for opencode agent campaigns";

  inputs = {
    # Pinned SDLC release; reusable workflows should pin the same revision.
    sdlc.url = "github:blogle/sdlc/v2.1.5";

    # Documentation workbench (no release tags yet; pinned by revision).
    fieldnotes.url = "github:blogle/fieldnotes/60f863bc41820fffda1ad8e950438a19b1dbdc2b";

    # Rust build caching; follows SDLC's nixpkgs per the consumer contract.
    crane = {
      url = "github:ipetkov/crane";
      inputs.nixpkgs.follows = "sdlc/nixpkgs-latest";
    };
  };

  outputs = { self, sdlc, fieldnotes, crane }:
    let
      systems = [ "x86_64-linux" ];
      nixpkgs = sdlc.nixpkgs-latest;
    in
    {
      apps = nixpkgs.lib.genAttrs systems (system: {
        docs = {
          type = "app";
          program = "${fieldnotes.packages.${system}.default}/bin/fieldnotes";
        };
        sdlc = {
          type = "app";
          program = "${sdlc.packages.${system}.sdlc}/bin/sdlc";
        };
      });

      packages = nixpkgs.lib.genAttrs systems (system:
        let pkgs = nixpkgs.legacyPackages.${system};
        in {
          nix-eval-jobs = pkgs.nix-eval-jobs;
        });

      devShells = nixpkgs.lib.genAttrs systems (system:
        let pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = pkgs.mkShell {
            packages = sdlc.lib.devTools {
              inherit pkgs;
              sdlcCli = sdlc.packages.${system}.sdlc;
            } ++ [ pkgs.just pkgs.gh ];
          };
        });
    };
}
