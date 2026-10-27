{ self, system }:
{
  check = {
    flake = self.checks.${system}.flake;
    format = self.checks.${system}.fmt;
    clippy = self.checks.${system}.clippy;
  };
  verify = {
    build = self.checks.${system}.build;
    test = self.checks.${system}.test;
    typescript = self.checks.${system}.typescript;
  };
}
