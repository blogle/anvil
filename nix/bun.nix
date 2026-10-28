{ pkgs }:

pkgs.stdenvNoCC.mkDerivation {
  pname = "bun";
  version = "1.2.5";
  src = pkgs.fetchurl {
    url = "https://github.com/oven-sh/bun/releases/download/bun-v1.2.5/bun-linux-x64.zip";
    hash = "sha256-iPZL7e4zD/TWMo4+kMZpvHrFMUknxgT4XjKeoqHRl5s=";
  };
  nativeBuildInputs = [ pkgs.autoPatchelfHook pkgs.unzip ];
  buildInputs = [ pkgs.glibc ];
  dontUnpack = true;
  dontBuild = true;
  installPhase = ''
    install -d "$out/bin"
    unzip -p "$src" bun-linux-x64/bun > "$out/bin/bun"
    chmod 755 "$out/bin/bun"
  '';
}
