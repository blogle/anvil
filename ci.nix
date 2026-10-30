{ self, system }:
{
  check = {
    flake = self.checks.${system}.flake;
  };
  verify = {
    typescript = self.checks.${system}.typescript;
  };
}
