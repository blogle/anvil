{
  pkgs,
  nix2container,
  anvilctl,
}:
let
  opencode-src = pkgs.fetchurl {
    url = "https://github.com/anomalyco/opencode/releases/download/v1.18.35/opencode-linux-x64-musl.tar.gz";
    hash = "sha256-o2R+0fux1S+8R8AsMbZBf+DW8OY54nsJX0fCabYL/tU=";
  };

  opencode = pkgs.runCommand "opencode" { } ''
    mkdir -p $out/bin
    tar -xf ${opencode-src} -C $out/bin
    chmod +x $out/bin/opencode
  '';

  entrypoint = pkgs.writeShellScriptBin "anvil-entrypoint" ''
    set -euo pipefail
    export PATH=/bin
    export HOME=/workspace/home
    export NIX_REMOTE=daemon
    export GIT_TERMINAL_PROMPT=0
    mkdir -p "$HOME"
    git config --global --add safe.directory '*'
    if [ ! -d /workspace/repo ]; then
      git -c credential.helper='!f() { printf "username=anvil\npassword=%s\n" "$ANVIL_GITHUB_TOKEN"; }; f' \
        clone "''${ANVIL_REPO_URL}" /workspace/repo
    fi
    cd /workspace/repo
    if ! git checkout "$ANVIL_REPO_BRANCH" 2>/dev/null; then
      git checkout -b "$ANVIL_REPO_BRANCH" "origin/$ANVIL_TARGET_REF"
    fi
    exec /bin/opencode serve --hostname 0.0.0.0 --port "''${ANVIL_SERVE_PORT:-4096}"
  '';

  tools = pkgs.buildEnv {
    name = "anvil-sandbox-tools";
    paths = [
      pkgs.bashInteractive
      pkgs.coreutils
      pkgs.findutils
      pkgs.gnugrep
      pkgs.gnused
      pkgs.gawk
      pkgs.gnutar
      pkgs.gzip
      pkgs.xz
      pkgs.unzip
      pkgs.git
      pkgs.curl
      pkgs.jq
      pkgs.ripgrep
      pkgs.less
      pkgs.procps
      pkgs.which
      pkgs.nix
      pkgs.musl
      pkgs.cacert
      opencode
    ];
    pathsToLink = [ "/bin" "/lib" "/etc" ];
  };

  anvil-side = pkgs.buildEnv {
    name = "anvil-sandbox-control";
    paths = [ anvilctl entrypoint ];
    pathsToLink = [ "/bin" ];
  };
in
nix2container.buildImage {
  name = "anvil-sandbox";
  tag = "latest";
  copyToRoot = [
    tools
    anvil-side
  ];
  layers = [
    (nix2container.buildLayer { deps = [ tools ]; })
  ];
  config = {
    Entrypoint = [ "/bin/anvil-entrypoint" ];
    Env = [
      "PATH=/bin"
      "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      "GIT_SSL_CAINFO=/etc/ssl/certs/ca-bundle.crt"
    ];
  };
}
