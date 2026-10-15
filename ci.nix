{ self, pkgs, system }:
let
  publishHook = pkgs.writeShellApplication {
    name = "anvil-v2-publish";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      printf '%s\n' "Anvil v2 publication is disabled until product artifacts exist." >&2
      exit 1
    '';
  };
in {
  fast = {
    fmt = self.checks.${system}.fmt;
    clippy = self.checks.${system}.clippy;
  };
  verify = {
    build = self.checks.${system}.build;
    tests = self.checks.${system}.tests;
  };
  publish = {
    type = "app";
    program = "${publishHook}/bin/anvil-v2-publish";
  };
}
