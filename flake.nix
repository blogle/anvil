{
  description = "Anvil development environment and reproducible Rust builds";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    crane.url = "github:ipetkov/crane";
    # Temporary pin for nlewo/nix2container#199 / issue #192.
    # Remove this fork pin after the upstream fix lands in nlewo/nix2container.
    nix2container.url = "github:Dauliac/nix2container/8fd02c842686a528fd37508283853de0ed1462b1";
    nix2containerNixpkgs.follows = "nix2container/nixpkgs";
    opencode.url = "github:anomalyco/opencode/v1.18.30";
  };

  outputs = { self, nixpkgs, flake-utils, crane, nix2container, nix2containerNixpkgs, opencode }:
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
          nix2containerBuildPkgs = nix2containerNixpkgs.legacyPackages.${system};
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
        packages.anvil-nix-daemon-image = sandbox.daemonImage;
        packages.anvil-nix-daemon-upgrade-test-image = sandbox.daemonUpgradeImage;
        packages.anvil-nix-daemon-upgrade-test-canary = sandbox.daemonUpgradeCanary;
        packages.anvil-nix-daemon-image-push = sandbox.daemonImagePush;
        packages.anvil-sandbox-image-push = sandbox.sandboxImagePush;
        packages.import-sandbox-image-k3s = sandbox.importSandboxImageK3s;

        checks = rust.checks;
        devShells.default = rust.devShell;
        # Kind already validates Rust in the independent local-first job. This
        # shell keeps the shared-daemon contract focused on environment entry
        # instead of triggering the full Cargo artifact seed.
        devShells.shared-nix-smoke = pkgs.mkShell {
          packages = [ pkgs.bash pkgs.just pkgs.nix ];
          shellHook = ''
            export ANVIL_SHARED_NIX_SMOKE=1
          '';
        };
        # Kind owns Kubernetes/image/runtime fidelity, not Cargo validation.
        # Do not enter rust.devShell here: its hook seeds the full dependency
        # artifact set before the acceptance script can start.
        devShells.kind-ci = pkgs.mkShell {
          packages = [
            pkgs.bash pkgs.curl pkgs.gitMinimal pkgs.jq pkgs.just pkgs.kind
            pkgs.kubectl pkgs.kustomize pkgs.nix pkgs.util-linux
            nix2container.packages.${system}.skopeo-nix2container
          ];
        };
      });
}
