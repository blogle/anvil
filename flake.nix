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
        craneLib = crane.mkLib pkgs;
        rust = import ./nix/rust.nix {
          inherit pkgs craneLib opencode;
          nix2containerPkgs = nix2container.packages.${system};
          repoRoot = ./.;
        };
        sandbox = import ./nix/sandbox.nix {
          inherit pkgs opencode;
          nix2containerPkgs = nix2container.packages.${system};
          credentialHelperSource = ./runtime/anvil-credential;
          sandboxEntrypointSource = ./runtime/sandbox-entrypoint;
          importSandboxImageK3sSource = ./scripts/import-sandbox-image-k3s.sh;
        };
        images = import ./nix/images.nix {
          inherit pkgs rust;
        };
      in
      {
        packages.default = images.anvilImage;
        packages.anvild = rust.releaseBinaries.anvild;
        packages.anvil-mcp = rust.releaseBinaries.anvilMcp;
        packages.anvil-router = rust.releaseBinaries.anvilRouter;
        packages.anvilctl = rust.releaseBinaries.anvilCtl;
        packages.anvil-image = images.anvilImage;
        packages.anvil-image-ci = images.anvilImageCi;
        packages.anvil-sandbox-image = sandbox.sandboxImage;
        packages.anvil-sandbox-image-push = sandbox.sandboxImagePush;
        packages.import-sandbox-image-k3s = sandbox.importSandboxImageK3s;

        checks = rust.checks;
        devShells.default = rust.devShell;
      });
}
