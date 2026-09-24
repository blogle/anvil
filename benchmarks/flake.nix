{
  inputs = {
    root.url = "..";
    nixpkgs.follows = "root/nixpkgs";
    flake-utils.follows = "root/flake-utils";
    nix2container.follows = "root/nix2container";
    opencode.follows = "root/opencode";
  };

  outputs = { self, nixpkgs, flake-utils, nix2container, opencode, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        sandbox = import ../nix/sandbox.nix {
          inherit pkgs opencode;
          nix2containerPkgs = nix2container.packages.${system};
          repoRoot = ../.;
        };
        benchmarkSandboxImage = pkgs.writeShellApplication {
          name = "benchmark-sandbox-image";
          runtimeInputs = [ pkgs.coreutils pkgs.nix ];
          text = builtins.readFile ./benchmark-sandbox-image.sh;
        };
      in
      {
        packages = {
          anvil-sandbox-image = sandbox.sandboxImage;
          anvil-sandbox-image-env-cmd = sandbox.mkSandboxImage {
            tag = "benchmark-env-cmd";
            config = sandbox.sandboxConfig // {
              Cmd = [ "/bin/sandbox-entrypoint" "--benchmark-env-cmd" ];
              Env = sandbox.sandboxConfig.Env ++ [ "ANVIL_BENCHMARK=env-cmd" ];
            };
          };
          anvil-sandbox-image-entrypoint = sandbox.mkSandboxImage {
            tag = "benchmark-entrypoint";
            entrypointPackage = pkgs.writeShellScriptBin "sandbox-entrypoint" ''
              exec ${sandbox.sandboxEntrypoint}/bin/sandbox-entrypoint "$@"
            '';
          };
          anvil-sandbox-image-opencode = sandbox.mkSandboxImage {
            tag = "benchmark-opencode";
            opencode = pkgs.runCommand "opencode-version-change" {} ''
              cp -a ${sandbox.opencodePackage}/. "$out/"
              chmod -R u+w "$out"
              mkdir -p "$out/share/anvil"
              printf 'benchmark OpenCode version change\n' > "$out/share/anvil/version-change"
            '';
          };
          anvil-sandbox-image-chromium = sandbox.mkSandboxImage {
            tag = "benchmark-chromium";
            chromium = pkgs.runCommand "chromium-version-change" {} ''
              cp -a ${sandbox.chromiumForImage}/. "$out/"
              chmod -R u+w "$out"
              mkdir -p "$out/share/anvil"
              printf 'benchmark Chromium version change\n' > "$out/share/anvil/version-change"
            '';
          };
          benchmark-sandbox-image = benchmarkSandboxImage;
        };
      });
}
