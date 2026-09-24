{ pkgs, rust }:

let
  mkAnvilImage = {
    name,
    tag,
    binaries,
  }:
    pkgs.dockerTools.buildLayeredImage {
      inherit name tag;
      contents = [
        binaries.anvild
        binaries.anvilMcp
        binaries.anvilRouter
        pkgs.cacert
      ];
      config = {
        Cmd = [ "/bin/anvild" ];
        Env = [ "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt" ];
      };
    };
in
{
  anvilImage = mkAnvilImage {
    name = "anvil";
    tag = "dev";
    binaries = rust.releaseBinaries;
  };

  # This image intentionally has the same runtime filesystem and config as
  # anvilImage; only the Rust profile and dependency artifacts differ.
  anvilImageCi = mkAnvilImage {
    name = "anvil-ci";
    tag = "dev";
    binaries = rust.ciReleaseBinaries;
  };
}
