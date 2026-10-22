{
  description = "Anvil development environment and reproducible Rust builds";

  inputs = {
    nixpkgs.follows = "sdlc/nixpkgs";
    flake-utils.url = "github:numtide/flake-utils";
    crane.url = "github:ipetkov/crane";
    # Temporary pin for nlewo/nix2container#199 / issue #192.
    # Remove this fork pin after the upstream fix lands in nlewo/nix2container.
    nix2container.url = "github:Dauliac/nix2container/8fd02c842686a528fd37508283853de0ed1462b1";
    nix2containerNixpkgs.follows = "nix2container/nixpkgs";
    opencode.url = "github:anomalyco/opencode/9b4ec5714d481559990db0a816d5dec19541a814";
    sdlc.url = "github:blogle/sdlc/b5c3d52602a4153bdb62d3502e248a589762abdf";
  };

  outputs = { self, nixpkgs, flake-utils, crane, nix2container, nix2containerNixpkgs, opencode, sdlc }:
    flake-utils.lib.eachSystem [ "x86_64-linux" ] (system:
      let
        pkgs = import nixpkgs { inherit system; };
        # The upstream V2 package's install check invokes `opencode --version`
        # in a context where its runtime creates /tmp and fails under Nix's
        # install-check sandbox. Keep the upstream default build unchanged and
        # disable only that non-hermetic runtime check.
        opencodePackage = opencode.packages.${system}.default.overrideAttrs (_: { doInstallCheck = false; });
        craneLib = crane.mkLib pkgs;
        rust = import ./nix/rust.nix {
          inherit pkgs craneLib;
          inherit opencodePackage;
          nix2containerPkgs = nix2container.packages.${system};
          repoRoot = ./.;
        };
        frontend = pkgs.buildNpmPackage {
          pname = "anvil-web";
          version = "0.1.0";
          src = ./web;
          npmDepsHash = "sha256-jSbL4XIRQbOg6DGmouNpFpiVHE9MNKLJn3Wxzfn0yfk=";
          npmBuildScript = "build";
          installPhase = ''
            mkdir -p $out
            cp -r dist/. $out/
          '';
        };
        sandbox = import ./nix/sandbox.nix {
          inherit pkgs;
          inherit opencodePackage;
          nix2containerPkgs = nix2container.packages.${system};
          nix2containerBuildPkgs = nix2containerNixpkgs.legacyPackages.${system};
          credentialHelperSource = ./runtime/anvil-credential;
          sessionCapabilityHelperSource = ./runtime/anvil-session-capability;
          sandboxEntrypointSource = ./runtime/sandbox-entrypoint;
          importSandboxImageK3sSource = ./scripts/import-sandbox-image-k3s.sh;
        };
        images = import ./nix/images.nix {
          inherit pkgs rust frontend;
        };
        publishImages = pkgs.writeShellApplication {
          name = "anvil-sdlc-publish";
          runtimeInputs = [ pkgs.coreutils pkgs.docker pkgs.jq pkgs.nix nix2container.packages.${system}.skopeo-nix2container ];
          text = builtins.readFile ./scripts/release-publish.sh;
        };
        ciContract = import ./ci.nix {
          inherit pkgs craneLib rust frontend images sandbox;
          repoRoot = ./.;
          opencodePackage = rust.opencodePackage;
          publish = {
            type = "app";
            program = "${publishImages}/bin/anvil-sdlc-publish";
          };
        };
        ci = sdlc.lib.mkConsumer {
          inherit (ciContract) fast verify publish;
        };
      in
      {
        packages.sdlc = sdlc.packages.${system}.sdlc;
        packages.default = images.anvilImage;
        packages.anvild = rust.releaseBinaries.anvild;
        packages.frontend = frontend;
        packages.anvil-mcp = rust.releaseBinaries.anvilMcp;
        packages.anvil-router = rust.releaseBinaries.anvilRouter;
        packages.anvilctl = rust.releaseBinaries.anvilCtl;
        packages.anvil-image = images.anvilImage;
        packages.anvil-image-ci = images.anvilImageCi;
        packages.anvil-ci-release-cargo-artifacts = rust.ciReleaseCargoArtifacts;
        packages.anvil-sandbox-image = sandbox.sandboxImage;
        packages.anvil-nix-daemon-image = sandbox.daemonImage;
        packages.anvil-nix-daemon-upgrade-test-image = sandbox.daemonUpgradeImage;
        packages.anvil-nix-daemon-upgrade-test-canary = sandbox.daemonUpgradeCanary;
        packages.anvil-nix-daemon-image-push = sandbox.daemonImagePush;
        packages.anvil-sandbox-image-push = sandbox.sandboxImagePush;
        packages.import-sandbox-image-k3s = sandbox.importSandboxImageK3s;

        ci = ci;
        checks = ciContract.checks // {
          crateFixtureSource = rust.fixtureSourceSmoke;
        };
        devShells.default = rust.devShell;
        # The release workflow smoke-tests the built daemon image with Docker.
        # Keep this shell minimal so release validation does not seed Cargo.
        devShells.release-smoke = pkgs.mkShell {
          packages = [ pkgs.bash pkgs.coreutils pkgs.docker pkgs.findutils pkgs.nix pkgs.util-linux ];
        };
      });
}
