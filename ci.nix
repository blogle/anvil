{ self, system }:
{
  schemaVersion = 1;
  stages = {
    pr-fast = {
      format = self.checks.${system}.fmt;
      frontend = self.checks.${system}.frontend;
      contract = self.checks.${system}.sdlc-stage-contract;
    };
    candidate = {
      clippy = self.checks.${system}.clippy;
      tests = self.checks.${system}.tests;
      anvil = self.packages.${system}.anvil-image-ci;
      sandbox = self.packages.${system}.anvil-sandbox-image;
      daemon = self.packages.${system}.anvil-nix-daemon-image;
    };
  };
}
