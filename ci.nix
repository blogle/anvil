{ self, system }:
{
  check = {
    fmt = self.checks.${system}.fmt;
    clippy = self.checks.${system}.clippy;
    test = self.checks.${system}.test;
  };
  verify = {
    anvil = self.packages.${system}.anvil;
    anvild = self.packages.${system}.anvild;
    anvilctl = self.packages.${system}.anvilctl;
    anvil-router = self.packages.${system}.anvil-router;
  };
}
