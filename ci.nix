{ self, system }:
{
  schemaVersion = 1;
  stages = {
    pr-fast = {
      flake = self.checks.${system}.flake;
      format = self.checks.${system}.fmt;
      clippy = self.checks.${system}.clippy;
    };
    candidate = {
      build = self.checks.${system}.build;
      test = self.checks.${system}.test;
    };
  };
}
